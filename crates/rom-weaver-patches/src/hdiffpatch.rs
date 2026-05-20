use std::{
    fs::{self, File},
    io::{self, BufWriter, Cursor, Read, Write},
    path::Path,
};

use bzip2::read::BzDecoder;
use flate2::read::{DeflateDecoder, ZlibDecoder};
use lzma_rust2::{Lzma2Reader, LzmaReader};
use memmap2::{Mmap, MmapOptions};
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    ThreadCapability,
};

pub struct HdiffPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl HdiffPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }
}

impl PatchHandler for HdiffPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let patch = map_file_read_only(patch_path)?;
        let variant = parse_hdiff_patch_view(patch.as_ref())?;
        let label = match variant {
            ParsedPatchVariant::SingleFile13(header) => format!(
                "parsed {} patch: HDIFF13 comp={} old={} new={} cover_count={} new_diff={} byte(s)",
                self.descriptor.name,
                header.compression.as_str(),
                header.old_data_size,
                header.new_data_size,
                header.cover_count,
                header.new_data_diff_size
            ),
            ParsedPatchVariant::SingleStream20(header) => format!(
                "parsed {} patch: HDIFFSF20 comp={} old={} new={} cover_count={} step_mem={} uncompressed={} compressed={} byte(s)",
                self.descriptor.name,
                header.compression.as_str(),
                header.old_data_size,
                header.new_data_size,
                header.cover_count,
                header.step_mem_size,
                header.uncompressed_size,
                header.compressed_size
            ),
            ParsedPatchVariant::Directory19(header) => format!(
                "parsed {} patch: HDIFF19 comp={} old={} new={} (directory patch; apply unsupported)",
                self.descriptor.name,
                header.compression.as_str(),
                header.old_data_size,
                header.new_data_size
            ),
        };

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            label,
            Some(100.0),
            None,
        ))
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let patch_path = crate::require_single_patch_file(&request.patches, self.descriptor.name)?;
        let patch = map_file_read_only(patch_path)?;
        let variant = parse_hdiff_patch_view(patch.as_ref())?;

        let old_bytes = map_file_read_only(&request.input)?;
        let old_len = u64::try_from(old_bytes.as_ref().len()).map_err(|_| {
            RomWeaverError::Validation("HDiffPatch input size overflowed u64".into())
        })?;

        let output_bytes = match variant {
            ParsedPatchVariant::SingleFile13(header) => {
                if old_len != header.old_data_size {
                    return Err(RomWeaverError::Validation(format!(
                        "HDiffPatch source size mismatch: expected {} byte(s), got {} byte(s)",
                        header.old_data_size, old_len
                    )));
                }
                apply_hdiff13(old_bytes.as_ref(), patch.as_ref(), &header)?
            }
            ParsedPatchVariant::SingleStream20(header) => {
                if old_len != header.old_data_size {
                    return Err(RomWeaverError::Validation(format!(
                        "HDiffPatch source size mismatch: expected {} byte(s), got {} byte(s)",
                        header.old_data_size, old_len
                    )));
                }
                apply_hdiffsf20(old_bytes.as_ref(), patch.as_ref(), &header)?
            }
            ParsedPatchVariant::Directory19(_) => {
                return Err(RomWeaverError::Unsupported(
                    "HDiffPatch directory patches (HDIFF19) are not supported for patch-apply; expected single-file patch (.hdiff/.hpatchz)".into(),
                ));
            }
        };

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = BufWriter::new(File::create(&request.output)?);
        output.write_all(&output_bytes)?;
        output.flush()?;

        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch; output {} byte(s)",
                self.descriptor.name,
                output_bytes.len()
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = Some(context.plan_threads(ThreadCapability::single_threaded()));
        Ok(OperationReport::unsupported(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            "HDiffPatch/HPatchZ patch creation is disabled; use upstream hdiffz/hpatchz tooling",
            execution,
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: true,
            apply: true,
            create: false,
            threaded_scan: false,
            threaded_diff: false,
            threaded_output: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HdiffCompression {
    NoComp,
    Zstd,
    Zlib,
    Bz2,
    Lzma,
    Lzma2,
}

impl HdiffCompression {
    fn parse(value: &str) -> Result<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | "nocomp" => Ok(Self::NoComp),
            "zstd" => Ok(Self::Zstd),
            "zlib" => Ok(Self::Zlib),
            "bz2" | "pbz2" => Ok(Self::Bz2),
            "lzma" => Ok(Self::Lzma),
            "lzma2" => Ok(Self::Lzma2),
            other => Err(RomWeaverError::Validation(format!(
                "HDiffPatch compression `{other}` is not recognized"
            ))),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::NoComp => "nocomp",
            Self::Zstd => "zstd",
            Self::Zlib => "zlib",
            Self::Bz2 => "bz2",
            Self::Lzma => "lzma",
            Self::Lzma2 => "lzma2",
        }
    }
}

#[derive(Clone, Debug)]
struct ParsedHdiff13 {
    compression: HdiffCompression,
    old_data_size: u64,
    new_data_size: u64,
    cover_count: u64,
    cover_buf_size: u64,
    compress_cover_buf_size: u64,
    rle_ctrl_buf_size: u64,
    compress_rle_ctrl_buf_size: u64,
    rle_code_buf_size: u64,
    compress_rle_code_buf_size: u64,
    new_data_diff_size: u64,
    compress_new_data_diff_size: u64,
    header_end: usize,
}

#[derive(Clone, Debug)]
struct ParsedHdiffSf20 {
    compression: HdiffCompression,
    old_data_size: u64,
    new_data_size: u64,
    cover_count: u64,
    step_mem_size: u64,
    uncompressed_size: u64,
    compressed_size: u64,
    diff_data_pos: usize,
}

#[derive(Clone, Debug)]
struct ParsedHdiffDir19 {
    compression: HdiffCompression,
    old_data_size: u64,
    new_data_size: u64,
}

#[derive(Clone, Debug)]
enum ParsedPatchVariant {
    SingleFile13(ParsedHdiff13),
    SingleStream20(ParsedHdiffSf20),
    Directory19(ParsedHdiffDir19),
}

#[cfg(test)]
struct ParsedPatchFile {
    bytes: Vec<u8>,
    variant: ParsedPatchVariant,
}

#[cfg(test)]
fn parse_hdiff_patch_bytes(bytes: Vec<u8>) -> Result<ParsedPatchFile> {
    let variant = parse_hdiff_patch_view(bytes.as_slice())?;
    Ok(ParsedPatchFile { bytes, variant })
}

fn parse_hdiff_patch_view(raw: &[u8]) -> Result<ParsedPatchVariant> {
    let (header_text, mut index) = read_null_terminated_string(raw, 1024)?;
    let parts = header_text.split('&').collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err(RomWeaverError::Validation(
            "HDiffPatch header is incomplete".into(),
        ));
    }

    let magic = parts[0];
    let compression = HdiffCompression::parse(parts[1])?;

    let variant = if magic == "HDIFF13" {
        let new_data_size = read_var_u64(raw, &mut index, "new_data_size")?;
        let old_data_size = read_var_u64(raw, &mut index, "old_data_size")?;
        let cover_count = read_var_u64(raw, &mut index, "cover_count")?;
        let cover_buf_size = read_var_u64(raw, &mut index, "cover_buf_size")?;
        let compress_cover_buf_size = read_var_u64(raw, &mut index, "compress_cover_buf_size")?;
        let rle_ctrl_buf_size = read_var_u64(raw, &mut index, "rle_ctrl_buf_size")?;
        let compress_rle_ctrl_buf_size =
            read_var_u64(raw, &mut index, "compress_rle_ctrl_buf_size")?;
        let rle_code_buf_size = read_var_u64(raw, &mut index, "rle_code_buf_size")?;
        let compress_rle_code_buf_size =
            read_var_u64(raw, &mut index, "compress_rle_code_buf_size")?;
        let new_data_diff_size = read_var_u64(raw, &mut index, "new_data_diff_size")?;
        let compress_new_data_diff_size =
            read_var_u64(raw, &mut index, "compress_new_data_diff_size")?;

        ParsedPatchVariant::SingleFile13(ParsedHdiff13 {
            compression,
            old_data_size,
            new_data_size,
            cover_count,
            cover_buf_size,
            compress_cover_buf_size,
            rle_ctrl_buf_size,
            compress_rle_ctrl_buf_size,
            rle_code_buf_size,
            compress_rle_code_buf_size,
            new_data_diff_size,
            compress_new_data_diff_size,
            header_end: index,
        })
    } else if magic == "HDIFFSF20" {
        let new_data_size = read_var_u64(raw, &mut index, "new_data_size")?;
        let old_data_size = read_var_u64(raw, &mut index, "old_data_size")?;
        let cover_count = read_var_u64(raw, &mut index, "cover_count")?;
        let step_mem_size = read_var_u64(raw, &mut index, "step_mem_size")?;
        let uncompressed_size = read_var_u64(raw, &mut index, "uncompressed_size")?;
        let compressed_size = read_var_u64(raw, &mut index, "compressed_size")?;

        ParsedPatchVariant::SingleStream20(ParsedHdiffSf20 {
            compression,
            old_data_size,
            new_data_size,
            cover_count,
            step_mem_size,
            uncompressed_size,
            compressed_size,
            diff_data_pos: index,
        })
    } else if magic == "HDIFF19" {
        let is_input_dir = read_bool_byte(raw, &mut index, "is_input_dir")?;
        let is_output_dir = read_bool_byte(raw, &mut index, "is_output_dir")?;

        let _input_dir_count = read_var_u64(raw, &mut index, "input_dir_count")?;
        let input_sum_size = read_var_u64(raw, &mut index, "input_sum_size")?;
        let _output_dir_count = read_var_u64(raw, &mut index, "output_dir_count")?;
        let output_sum_size = read_var_u64(raw, &mut index, "output_sum_size")?;

        if !is_input_dir || !is_output_dir {
            return Err(RomWeaverError::Validation(
                "HDIFF19 patch flagged non-directory I/O unexpectedly".into(),
            ));
        }

        ParsedPatchVariant::Directory19(ParsedHdiffDir19 {
            compression,
            old_data_size: input_sum_size,
            new_data_size: output_sum_size,
        })
    } else {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch magic `{magic}` is not supported"
        )));
    };

    Ok(variant)
}

enum ReadOnlyFile {
    Mapped(Mmap),
    Owned(Vec<u8>),
}

impl AsRef<[u8]> for ReadOnlyFile {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Mapped(map) => map.as_ref(),
            Self::Owned(bytes) => bytes.as_slice(),
        }
    }
}

fn map_file_read_only(path: &Path) -> Result<ReadOnlyFile> {
    let file = File::open(path)?;
    // SAFETY: The mapping is read-only and the file handle lives for map creation.
    match unsafe { MmapOptions::new().map(&file) } {
        Ok(map) => Ok(ReadOnlyFile::Mapped(map)),
        Err(error) if should_fallback_from_mmap(&error) => Ok(ReadOnlyFile::Owned(fs::read(path)?)),
        Err(error) => Err(error.into()),
    }
}

fn should_fallback_from_mmap(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Unsupported
}

fn apply_hdiff13(old_bytes: &[u8], patch_bytes: &[u8], header: &ParsedHdiff13) -> Result<Vec<u8>> {
    let cover_raw = read_hdiff_chunk(
        patch_bytes,
        header.header_end,
        header.cover_buf_size,
        header.compress_cover_buf_size,
        header.compression,
        "cover",
    )?;
    let cover_end = add_usize_u64(
        header.header_end,
        hdiff_chunk_raw_size(header.cover_buf_size, header.compress_cover_buf_size),
        "cover end",
    )?;

    let rle_ctrl_raw = read_hdiff_chunk(
        patch_bytes,
        cover_end,
        header.rle_ctrl_buf_size,
        header.compress_rle_ctrl_buf_size,
        header.compression,
        "rle_ctrl",
    )?;
    let rle_ctrl_end = add_usize_u64(
        cover_end,
        hdiff_chunk_raw_size(header.rle_ctrl_buf_size, header.compress_rle_ctrl_buf_size),
        "rle_ctrl end",
    )?;

    let rle_code_raw = read_hdiff_chunk(
        patch_bytes,
        rle_ctrl_end,
        header.rle_code_buf_size,
        header.compress_rle_code_buf_size,
        header.compression,
        "rle_code",
    )?;
    let rle_code_end = add_usize_u64(
        rle_ctrl_end,
        hdiff_chunk_raw_size(header.rle_code_buf_size, header.compress_rle_code_buf_size),
        "rle_code end",
    )?;

    let new_diff_raw = read_hdiff_chunk(
        patch_bytes,
        rle_code_end,
        header.new_data_diff_size,
        header.compress_new_data_diff_size,
        header.compression,
        "new_data_diff",
    )?;

    let old_data_size = usize::try_from(header.old_data_size).map_err(|_| {
        RomWeaverError::Validation("HDiffPatch old_data_size overflowed usize".into())
    })?;
    if old_bytes.len() != old_data_size {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch source size mismatch: expected {} byte(s), got {} byte(s)",
            old_data_size,
            old_bytes.len()
        )));
    }

    let new_data_size = usize::try_from(header.new_data_size).map_err(|_| {
        RomWeaverError::Validation("HDiffPatch new_data_size overflowed usize".into())
    })?;
    let mut output = Vec::with_capacity(new_data_size);

    let mut cover_index = 0usize;
    let mut rle_ctrl_index = 0usize;
    let mut rle_code_index = 0usize;
    let mut new_diff_index = 0usize;

    let mut rle_state = HdiffRleState::default();

    let mut last_old_end = 0u64;
    let mut last_new_end = 0u64;
    let mut remaining_covers = header.cover_count;

    while remaining_covers > 0 {
        remaining_covers -= 1;

        let p_sign = read_u8_slice(cover_raw.as_slice(), &mut cover_index, "cover sign")?;
        let old_sign = p_sign >> 7;
        let old_delta = read_var_u64_tagged_slice(
            cover_raw.as_slice(),
            &mut cover_index,
            1,
            p_sign,
            "cover old_delta",
        )?;
        let old_pos = if old_sign == 0 {
            last_old_end.checked_add(old_delta).ok_or_else(|| {
                RomWeaverError::Validation("HDiffPatch cover old position overflowed".into())
            })?
        } else {
            last_old_end.checked_sub(old_delta).ok_or_else(|| {
                RomWeaverError::Validation("HDiffPatch cover old position underflowed".into())
            })?
        };

        let copy_length = read_var_u64_slice(cover_raw.as_slice(), &mut cover_index, "cover copy")?;
        let cover_length =
            read_var_u64_slice(cover_raw.as_slice(), &mut cover_index, "cover length")?;

        let new_pos = last_new_end.checked_add(copy_length).ok_or_else(|| {
            RomWeaverError::Validation("HDiffPatch cover new position overflowed".into())
        })?;

        let new_pos_usize = usize::try_from(new_pos).map_err(|_| {
            RomWeaverError::Validation("HDiffPatch new position overflowed usize".into())
        })?;
        if output.len() > new_pos_usize {
            return Err(RomWeaverError::Validation(
                "HDiffPatch cover new position moved backward".into(),
            ));
        }

        if output.len() < new_pos_usize {
            let fill_len = new_pos_usize - output.len();
            append_from_new_diff(
                &mut output,
                new_diff_raw.as_slice(),
                &mut new_diff_index,
                fill_len,
                "new_data_diff gap",
            )?;
            let begin = output.len() - fill_len;
            apply_hdiff_rle(
                &mut output[begin..],
                rle_ctrl_raw.as_slice(),
                &mut rle_ctrl_index,
                rle_code_raw.as_slice(),
                &mut rle_code_index,
                &mut rle_state,
            )?;
        }

        let old_start = usize::try_from(old_pos).map_err(|_| {
            RomWeaverError::Validation("HDiffPatch old position overflowed usize".into())
        })?;
        let cover_len_usize = usize::try_from(cover_length).map_err(|_| {
            RomWeaverError::Validation("HDiffPatch cover length overflowed usize".into())
        })?;
        let old_end = old_start.checked_add(cover_len_usize).ok_or_else(|| {
            RomWeaverError::Validation("HDiffPatch cover old range overflowed".into())
        })?;
        if old_end > old_bytes.len() {
            return Err(RomWeaverError::Validation(format!(
                "HDiffPatch cover exceeded old data bounds: {}..{} of {}",
                old_start,
                old_end,
                old_bytes.len()
            )));
        }

        output.extend_from_slice(&old_bytes[old_start..old_end]);
        let begin = output.len() - cover_len_usize;
        apply_hdiff_rle(
            &mut output[begin..],
            rle_ctrl_raw.as_slice(),
            &mut rle_ctrl_index,
            rle_code_raw.as_slice(),
            &mut rle_code_index,
            &mut rle_state,
        )?;

        last_old_end = old_pos
            .checked_add(cover_length)
            .ok_or_else(|| RomWeaverError::Validation("HDiffPatch old end overflowed".into()))?;
        last_new_end = new_pos
            .checked_add(cover_length)
            .ok_or_else(|| RomWeaverError::Validation("HDiffPatch new end overflowed".into()))?;
    }

    if output.len() < new_data_size {
        let fill_len = new_data_size - output.len();
        append_from_new_diff(
            &mut output,
            new_diff_raw.as_slice(),
            &mut new_diff_index,
            fill_len,
            "new_data_diff tail",
        )?;
        let begin = output.len() - fill_len;
        apply_hdiff_rle(
            &mut output[begin..],
            rle_ctrl_raw.as_slice(),
            &mut rle_ctrl_index,
            rle_code_raw.as_slice(),
            &mut rle_code_index,
            &mut rle_state,
        )?;
    }

    if output.len() != new_data_size {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch output size mismatch: expected {} byte(s), got {} byte(s)",
            new_data_size,
            output.len()
        )));
    }

    Ok(output)
}

fn apply_hdiffsf20(
    old_bytes: &[u8],
    patch_bytes: &[u8],
    header: &ParsedHdiffSf20,
) -> Result<Vec<u8>> {
    let diff_start = header.diff_data_pos;
    let diff_raw_len = hdiff_chunk_raw_size(header.uncompressed_size, header.compressed_size);
    let diff_end = add_usize_u64(diff_start, diff_raw_len, "HDIFFSF20 diff end")?;
    if diff_end > patch_bytes.len() {
        return Err(RomWeaverError::Validation(
            "HDIFFSF20 payload exceeded patch length".into(),
        ));
    }

    let diff = if header.compressed_size == 0 {
        patch_bytes[diff_start..diff_end].to_vec()
    } else {
        decompress_hdiff_payload(
            header.compression,
            &patch_bytes[diff_start..diff_end],
            header.uncompressed_size,
            "HDIFFSF20 payload",
        )?
    };

    let mut diff_index = 0usize;
    let mut last_old_end = 0u64;
    let mut last_new_end = 0u64;
    let mut remaining_covers = header.cover_count;

    let mut output = Vec::with_capacity(usize::try_from(header.new_data_size).unwrap_or(0));

    while remaining_covers > 0 {
        let cover_buf_size = usize::try_from(read_var_u64_slice(
            &diff,
            &mut diff_index,
            "sf20 cover_buf_size",
        )?)
        .map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 cover_buf_size overflowed usize".into())
        })?;
        let rle_buf_size = usize::try_from(read_var_u64_slice(
            &diff,
            &mut diff_index,
            "sf20 rle_buf_size",
        )?)
        .map_err(|_| {
            RomWeaverError::Validation("HDIFFSF20 rle_buf_size overflowed usize".into())
        })?;

        let step_size = cover_buf_size
            .checked_add(rle_buf_size)
            .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 step size overflowed".into()))?;
        let step_end = diff_index
            .checked_add(step_size)
            .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 step end overflowed".into()))?;
        if step_end > diff.len() {
            return Err(RomWeaverError::Validation(
                "HDIFFSF20 step buffer exceeded payload".into(),
            ));
        }

        let covers = &diff[diff_index..diff_index + cover_buf_size];
        let rle = &diff[diff_index + cover_buf_size..step_end];
        diff_index = step_end;

        let mut cover_index = 0usize;
        let mut rle_decoder = HdiffSf20RleDecoder::new(rle);

        while cover_index < covers.len() && remaining_covers > 0 {
            let p_sign = read_u8_slice(covers, &mut cover_index, "sf20 cover sign")?;
            let delta =
                read_var_u64_tagged_slice(covers, &mut cover_index, 1, p_sign, "sf20 cover delta")?;
            let old_pos = if (p_sign >> 7) == 0 {
                last_old_end.checked_add(delta).ok_or_else(|| {
                    RomWeaverError::Validation("HDIFFSF20 old position overflowed".into())
                })?
            } else {
                last_old_end.checked_sub(delta).ok_or_else(|| {
                    RomWeaverError::Validation("HDIFFSF20 old position underflowed".into())
                })?
            };

            let new_gap = read_var_u64_slice(covers, &mut cover_index, "sf20 new gap")?;
            let cover_length = read_var_u64_slice(covers, &mut cover_index, "sf20 cover length")?;
            let new_pos = last_new_end.checked_add(new_gap).ok_or_else(|| {
                RomWeaverError::Validation("HDIFFSF20 new position overflowed".into())
            })?;

            let new_pos_usize = usize::try_from(new_pos).map_err(|_| {
                RomWeaverError::Validation("HDIFFSF20 new position overflowed usize".into())
            })?;
            if output.len() > new_pos_usize {
                return Err(RomWeaverError::Validation(
                    "HDIFFSF20 new position moved backward".into(),
                ));
            }

            if output.len() < new_pos_usize {
                let fill_len = new_pos_usize - output.len();
                append_from_new_diff(
                    &mut output,
                    diff.as_slice(),
                    &mut diff_index,
                    fill_len,
                    "sf20 diff gap",
                )?;
            }

            remaining_covers -= 1;

            let old_start = usize::try_from(old_pos).map_err(|_| {
                RomWeaverError::Validation("HDIFFSF20 old position overflowed usize".into())
            })?;
            let cover_len_usize = usize::try_from(cover_length).map_err(|_| {
                RomWeaverError::Validation("HDIFFSF20 cover length overflowed usize".into())
            })?;
            let old_end = old_start.checked_add(cover_len_usize).ok_or_else(|| {
                RomWeaverError::Validation("HDIFFSF20 old range overflowed".into())
            })?;
            if old_end > old_bytes.len() {
                return Err(RomWeaverError::Validation(
                    "HDIFFSF20 cover exceeded source bounds".into(),
                ));
            }

            output.extend_from_slice(&old_bytes[old_start..old_end]);
            let begin = output.len() - cover_len_usize;
            rle_decoder.add(&mut output[begin..])?;

            last_old_end = old_pos
                .checked_add(cover_length)
                .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 old end overflowed".into()))?;
            last_new_end = new_pos
                .checked_add(cover_length)
                .ok_or_else(|| RomWeaverError::Validation("HDIFFSF20 new end overflowed".into()))?;
        }
    }

    let new_data_size = usize::try_from(header.new_data_size)
        .map_err(|_| RomWeaverError::Validation("HDIFFSF20 new size overflowed usize".into()))?;
    if output.len() < new_data_size {
        let fill_len = new_data_size - output.len();
        append_from_new_diff(
            &mut output,
            diff.as_slice(),
            &mut diff_index,
            fill_len,
            "sf20 diff tail",
        )?;
    }

    if output.len() != new_data_size {
        return Err(RomWeaverError::Validation(format!(
            "HDIFFSF20 output size mismatch: expected {} byte(s), got {} byte(s)",
            new_data_size,
            output.len()
        )));
    }

    Ok(output)
}

fn read_hdiff_chunk(
    patch_bytes: &[u8],
    start: usize,
    plain_size: u64,
    compressed_size: u64,
    compression: HdiffCompression,
    label: &str,
) -> Result<Vec<u8>> {
    let raw_size = hdiff_chunk_raw_size(plain_size, compressed_size);
    let end = add_usize_u64(start, raw_size, label)?;
    if end > patch_bytes.len() {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} chunk exceeded patch length"
        )));
    }

    if compressed_size == 0 {
        let plain_len = usize::try_from(plain_size).map_err(|_| {
            RomWeaverError::Validation(format!("HDiffPatch {label} size overflowed usize"))
        })?;
        return Ok(patch_bytes[start..start + plain_len].to_vec());
    }

    if compression == HdiffCompression::NoComp {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} declared compressed bytes while using nocomp"
        )));
    }

    let compressed = &patch_bytes[start..end];
    decompress_hdiff_payload(compression, compressed, plain_size, label)
}

fn hdiff_chunk_raw_size(plain_size: u64, compressed_size: u64) -> u64 {
    if compressed_size == 0 {
        plain_size
    } else {
        compressed_size
    }
}

fn decompress_hdiff_payload(
    compression: HdiffCompression,
    compressed: &[u8],
    expected_len: u64,
    label: &str,
) -> Result<Vec<u8>> {
    match compression {
        HdiffCompression::NoComp => Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} declared compressed bytes while using nocomp"
        ))),
        HdiffCompression::Zstd => decompress_zstd_to_vec(compressed, expected_len, label),
        HdiffCompression::Zlib => decompress_zlib_to_vec(compressed, expected_len, label),
        HdiffCompression::Bz2 => decompress_bz2_to_vec(compressed, expected_len, label),
        HdiffCompression::Lzma => decompress_lzma_to_vec(compressed, expected_len, label),
        HdiffCompression::Lzma2 => decompress_lzma2_to_vec(compressed, expected_len, label),
    }
}

fn decompress_zstd_to_vec(compressed: &[u8], expected_len: u64, label: &str) -> Result<Vec<u8>> {
    let decoder = zstd::stream::read::Decoder::new(Cursor::new(compressed)).map_err(|error| {
        RomWeaverError::Validation(format!("HDiffPatch {label} zstd init failed: {error}"))
    })?;
    read_exact_decompressed_size(decoder, expected_len, label, "zstd")
}

fn decompress_zlib_to_vec(compressed: &[u8], expected_len: u64, label: &str) -> Result<Vec<u8>> {
    if compressed.is_empty() {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} zlib payload is missing windowBits prefix"
        )));
    }
    let window_bits = i8::from_ne_bytes([compressed[0]]);
    let payload = &compressed[1..];

    match window_bits {
        -15..=-8 => read_exact_decompressed_size(
            DeflateDecoder::new(Cursor::new(payload)),
            expected_len,
            label,
            "zlib(deflate)",
        ),
        8..=15 => read_exact_decompressed_size(
            ZlibDecoder::new(Cursor::new(payload)),
            expected_len,
            label,
            "zlib",
        ),
        _ => Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} zlib windowBits `{window_bits}` is unsupported"
        ))),
    }
}

fn decompress_bz2_to_vec(compressed: &[u8], expected_len: u64, label: &str) -> Result<Vec<u8>> {
    read_exact_decompressed_size(
        BzDecoder::new(Cursor::new(compressed)),
        expected_len,
        label,
        "bz2",
    )
}

fn decompress_lzma_to_vec(compressed: &[u8], expected_len: u64, label: &str) -> Result<Vec<u8>> {
    if compressed.is_empty() {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} lzma payload is missing properties"
        )));
    }
    let props_size = usize::from(compressed[0]);
    if props_size == 0 {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} lzma props size must be non-zero"
        )));
    }

    let props_begin = 1usize;
    let props_end = props_begin.checked_add(props_size).ok_or_else(|| {
        RomWeaverError::Validation(format!("HDiffPatch {label} lzma props overflowed"))
    })?;
    if props_end > compressed.len() {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} lzma properties exceeded payload"
        )));
    }

    let props = &compressed[props_begin..props_end];
    if props.len() < 5 {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} lzma properties are too short"
        )));
    }

    let props_byte = props[0];
    let dict_size = u32::from_le_bytes([props[1], props[2], props[3], props[4]]);
    let payload = &compressed[props_end..];

    let decoder = LzmaReader::new_with_props(
        Cursor::new(payload),
        expected_len,
        props_byte,
        dict_size,
        None,
    )
    .map_err(|error| {
        RomWeaverError::Validation(format!("HDiffPatch {label} lzma init failed: {error}"))
    })?;
    read_exact_decompressed_size(decoder, expected_len, label, "lzma")
}

fn decompress_lzma2_to_vec(compressed: &[u8], expected_len: u64, label: &str) -> Result<Vec<u8>> {
    if compressed.is_empty() {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} lzma2 payload is missing properties"
        )));
    }

    let property = compressed[0];
    let dict_size = decode_lzma2_dict_size(property, label)?;
    let payload = &compressed[1..];

    let decoder = Lzma2Reader::new(Cursor::new(payload), dict_size, None);
    read_exact_decompressed_size(decoder, expected_len, label, "lzma2")
}

fn decode_lzma2_dict_size(property: u8, label: &str) -> Result<u32> {
    let bits = u32::from(property);
    if (bits & !0x3f) != 0 {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} lzma2 property `{property}` has unsupported flag bits"
        )));
    }
    if bits > 40 {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} lzma2 property `{property}` exceeds max dictionary setting"
        )));
    }
    if bits == 40 {
        return Ok(u32::MAX);
    }

    let shift = bits / 2 + 11;
    let size = (2 | (bits & 1)).checked_shl(shift).ok_or_else(|| {
        RomWeaverError::Validation(format!(
            "HDiffPatch {label} lzma2 dictionary size overflowed"
        ))
    })?;
    Ok(size)
}

fn read_exact_decompressed_size(
    mut decoder: impl Read,
    expected_len: u64,
    label: &str,
    codec: &str,
) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).map_err(|error| {
        RomWeaverError::Validation(format!("HDiffPatch {label} {codec} decode failed: {error}"))
    })?;

    let expected = usize::try_from(expected_len).map_err(|_| {
        RomWeaverError::Validation(format!("HDiffPatch {label} expected size overflowed usize"))
    })?;
    if out.len() != expected {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} size mismatch after decompression: expected {expected}, got {}",
            out.len()
        )));
    }

    Ok(out)
}

#[derive(Default)]
struct HdiffRleState {
    set_length: usize,
    set_value: u8,
    copy_length: usize,
}

fn apply_hdiff_rle(
    target: &mut [u8],
    rle_ctrl: &[u8],
    rle_ctrl_index: &mut usize,
    rle_code: &[u8],
    rle_code_index: &mut usize,
    state: &mut HdiffRleState,
) -> Result<()> {
    let mut offset = 0usize;

    apply_hdiff_rle_pending(target, &mut offset, rle_code, rle_code_index, state, false)?;
    if offset >= target.len() {
        return Ok(());
    }
    if *rle_ctrl_index >= rle_ctrl.len() {
        return Ok(());
    }

    while offset < target.len() {
        if *rle_ctrl_index >= rle_ctrl.len() {
            return Ok(());
        }
        let p_sign = read_u8_slice(rle_ctrl, rle_ctrl_index, "rle ctrl")?;
        let rle_type = p_sign >> 6;
        let length =
            read_var_u64_tagged_slice(rle_ctrl, rle_ctrl_index, 2, p_sign, "rle ctrl length")?
                .checked_add(1)
                .ok_or_else(|| {
                    RomWeaverError::Validation("HDiffPatch rle length overflowed".into())
                })?;
        let length_usize = usize::try_from(length).map_err(|_| {
            RomWeaverError::Validation("HDiffPatch rle length overflowed usize".into())
        })?;

        if rle_type == 3 {
            state.copy_length = length_usize;
        } else if rle_type == 2 {
            state.set_length = length_usize;
            state.set_value = read_u8_slice(rle_code, rle_code_index, "rle value")?;
        } else {
            state.set_length = length_usize;
            state.set_value = (0u8).wrapping_sub(rle_type);
        }

        apply_hdiff_rle_pending(target, &mut offset, rle_code, rle_code_index, state, true)?;
    }

    Ok(())
}

fn apply_hdiff_rle_pending(
    target: &mut [u8],
    offset: &mut usize,
    rle_code: &[u8],
    rle_code_index: &mut usize,
    state: &mut HdiffRleState,
    allow_partial: bool,
) -> Result<()> {
    while *offset < target.len() {
        if state.set_length > 0 {
            let remaining = target.len() - *offset;
            let step = state.set_length.min(remaining);
            if state.set_value != 0 {
                for byte in &mut target[*offset..*offset + step] {
                    *byte = byte.wrapping_add(state.set_value);
                }
            }
            state.set_length -= step;
            *offset += step;
            if !allow_partial {
                continue;
            }
            if step < remaining {
                continue;
            }
        }

        if state.copy_length > 0 {
            let remaining = target.len() - *offset;
            let step = state.copy_length.min(remaining);
            if rle_code.len().saturating_sub(*rle_code_index) < step {
                return Err(RomWeaverError::Validation(
                    "HDiffPatch rle_code ended unexpectedly".into(),
                ));
            }
            let source = &rle_code[*rle_code_index..*rle_code_index + step];
            for (dst, src) in target[*offset..*offset + step]
                .iter_mut()
                .zip(source.iter().copied())
            {
                *dst = dst.wrapping_add(src);
            }
            *rle_code_index += step;
            state.copy_length -= step;
            *offset += step;
            if !allow_partial {
                continue;
            }
            if step < remaining {
                continue;
            }
        }

        break;
    }
    Ok(())
}

struct HdiffSf20RleDecoder<'a> {
    bytes: &'a [u8],
    index: usize,
    len_zero: usize,
    len_value: usize,
    decode_zero_phase: bool,
}

impl<'a> HdiffSf20RleDecoder<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            index: 0,
            len_zero: 0,
            len_value: 0,
            decode_zero_phase: true,
        }
    }

    fn add(&mut self, target: &mut [u8]) -> Result<()> {
        let mut offset = 0usize;

        while offset < target.len() {
            if self.len_zero > 0 {
                let step = self.len_zero.min(target.len() - offset);
                self.len_zero -= step;
                offset += step;
                continue;
            }

            if self.len_value > 0 {
                let step = self.len_value.min(target.len() - offset);
                if self.bytes.len().saturating_sub(self.index) < step {
                    return Err(RomWeaverError::Validation(
                        "HDIFFSF20 rle data ended unexpectedly".into(),
                    ));
                }
                let value_bytes = &self.bytes[self.index..self.index + step];
                for (dst, src) in target[offset..offset + step]
                    .iter_mut()
                    .zip(value_bytes.iter().copied())
                {
                    *dst = dst.wrapping_add(src);
                }
                self.index += step;
                self.len_value -= step;
                offset += step;
                continue;
            }

            if self.decode_zero_phase {
                self.decode_zero_phase = false;
                self.len_zero = read_rle_varint(self.bytes, &mut self.index, "sf20 rle zero")?;
            } else {
                self.decode_zero_phase = true;
                self.len_value = read_rle_varint(self.bytes, &mut self.index, "sf20 rle value")?;
            }
        }

        Ok(())
    }
}

fn read_rle_varint(bytes: &[u8], index: &mut usize, label: &str) -> Result<usize> {
    let first = read_u8_slice(bytes, index, label)?;
    let mut value = u64::from(first & 0x7f);

    if (first & 0x80) != 0 {
        loop {
            let byte = read_u8_slice(bytes, index, label)?;
            value = value
                .checked_shl(7)
                .and_then(|value| value.checked_add(u64::from(byte & 0x7f)))
                .ok_or_else(|| {
                    RomWeaverError::Validation("HDIFFSF20 rle varint overflowed".into())
                })?;
            if (byte & 0x80) == 0 {
                break;
            }
        }
    }

    usize::try_from(value)
        .map_err(|_| RomWeaverError::Validation("HDIFFSF20 rle varint overflowed usize".into()))
}

fn append_from_new_diff(
    output: &mut Vec<u8>,
    source: &[u8],
    source_index: &mut usize,
    len: usize,
    label: &str,
) -> Result<()> {
    if source.len().saturating_sub(*source_index) < len {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch {label} ended unexpectedly"
        )));
    }
    output.extend_from_slice(&source[*source_index..*source_index + len]);
    *source_index += len;
    Ok(())
}

fn read_null_terminated_string(bytes: &[u8], max_len: usize) -> Result<(String, usize)> {
    let limit = bytes.len().min(max_len);
    for index in 0..limit {
        if bytes[index] == 0 {
            let text = std::str::from_utf8(&bytes[..index]).map_err(|_| {
                RomWeaverError::Validation("HDiffPatch header contained non-UTF8 bytes".into())
            })?;
            return Ok((text.to_string(), index + 1));
        }
    }

    Err(RomWeaverError::Validation(
        "HDiffPatch header was missing null terminator".into(),
    ))
}

fn read_bool_byte(bytes: &[u8], index: &mut usize, label: &str) -> Result<bool> {
    Ok(read_u8_slice(bytes, index, label)? != 0)
}

fn read_u8_slice(bytes: &[u8], index: &mut usize, label: &str) -> Result<u8> {
    if *index >= bytes.len() {
        return Err(RomWeaverError::Validation(format!(
            "HDiffPatch ended unexpectedly while reading {label}"
        )));
    }
    let byte = bytes[*index];
    *index += 1;
    Ok(byte)
}

fn read_var_u64(bytes: &[u8], index: &mut usize, label: &str) -> Result<u64> {
    read_var_u64_tagged_slice(bytes, index, 0, 0, label)
}

fn read_var_u64_slice(bytes: &[u8], index: &mut usize, label: &str) -> Result<u64> {
    read_var_u64(bytes, index, label)
}

fn read_var_u64_tagged_slice(
    bytes: &[u8],
    index: &mut usize,
    tag_bits: u8,
    first_byte: u8,
    label: &str,
) -> Result<u64> {
    if tag_bits > 6 {
        return Err(RomWeaverError::Validation(
            "HDiffPatch varint tag_bits must be <= 6".into(),
        ));
    }

    let first = if tag_bits == 0 {
        read_u8_slice(bytes, index, label)?
    } else {
        first_byte
    };

    let continuation_bit = 1u8 << (7 - tag_bits);
    let payload_mask = continuation_bit - 1;

    let mut value = u64::from(first & payload_mask);
    if (first & continuation_bit) == 0 {
        return Ok(value);
    }

    loop {
        let byte = read_u8_slice(bytes, index, label)?;
        value = value
            .checked_shl(7)
            .and_then(|value| value.checked_add(u64::from(byte & 0x7f)))
            .ok_or_else(|| RomWeaverError::Validation("HDiffPatch varint overflowed".into()))?;
        if (byte & 0x80) == 0 {
            break;
        }
    }

    Ok(value)
}

fn add_usize_u64(start: usize, amount: u64, label: &str) -> Result<usize> {
    let amount = usize::try_from(amount)
        .map_err(|_| RomWeaverError::Validation(format!("HDiffPatch {label} overflowed usize")))?;
    start
        .checked_add(amount)
        .ok_or_else(|| RomWeaverError::Validation(format!("HDiffPatch {label} overflowed")))
}

#[cfg(test)]
fn write_var_u64(out: &mut Vec<u8>, mut value: u64) {
    let mut groups = [0u8; 10];
    let mut count = 0usize;
    loop {
        groups[count] = (value & 0x7f) as u8;
        count += 1;
        value >>= 7;
        if value == 0 {
            break;
        }
    }

    for index in (0..count).rev() {
        let mut byte = groups[index];
        if index != 0 {
            byte |= 0x80;
        }
        out.push(byte);
    }
}

#[cfg(test)]
fn build_uncompressed_hdiff13_patch(old_bytes: &[u8], new_bytes: &[u8]) -> Result<Vec<u8>> {
    let old_size = u64::try_from(old_bytes.len())
        .map_err(|_| RomWeaverError::Validation("old file length overflowed u64".into()))?;
    let new_size = u64::try_from(new_bytes.len())
        .map_err(|_| RomWeaverError::Validation("new file length overflowed u64".into()))?;

    let mut out = Vec::with_capacity(64usize.saturating_add(new_bytes.len()));
    write_uncompressed_hdiff13_header_vec(&mut out, old_size, new_size);

    out.extend_from_slice(new_bytes);
    Ok(out)
}

#[cfg(test)]
fn write_uncompressed_hdiff13_header_vec(out: &mut Vec<u8>, old_size: u64, new_size: u64) {
    out.extend_from_slice(b"HDIFF13&nocomp");
    out.push(0);
    write_var_u64(out, new_size);
    write_var_u64(out, old_size);
    write_var_u64(out, 0); // cover_count
    write_var_u64(out, 0); // cover_buf_size
    write_var_u64(out, 0); // compress_cover_buf_size
    write_var_u64(out, 0); // rle_ctrl_buf_size
    write_var_u64(out, 0); // compress_rle_ctrl_buf_size
    write_var_u64(out, 0); // rle_code_buf_size
    write_var_u64(out, 0); // compress_rle_code_buf_size
    write_var_u64(out, new_size); // new_data_diff_size
    write_var_u64(out, 0); // compress_new_data_diff_size
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Write, path::PathBuf};

    use rom_weaver_core::{PatchApplyRequest, PatchCreateRequest, PatchHandler};

    use super::{
        HdiffPatchHandler, apply_hdiff13, apply_hdiffsf20, build_uncompressed_hdiff13_patch,
        write_var_u64,
    };
    use crate::{
        HDIFFPATCH,
        test_support::{TestDir, test_context_with_threads},
    };

    #[test]
    fn create_is_reported_as_unsupported() {
        let temp = TestDir::new();
        let patch_path = temp.child("update.hdiff");
        let source_path = temp.child("source.bin");
        let target_path = temp.child("target.bin");
        fs::write(&source_path, b"source").expect("source");
        fs::write(&target_path, b"target").expect("target");

        let handler = HdiffPatchHandler::new(&HDIFFPATCH);
        let report = handler
            .create(
                &PatchCreateRequest {
                    original: source_path.clone(),
                    modified: target_path.clone(),
                    output: patch_path.clone(),
                    format: "hdiffpatch".into(),
                },
                &test_context_with_threads(&temp, 4),
            )
            .expect("create report");

        assert_eq!(report.status, rom_weaver_core::OperationStatus::Unsupported);
        assert!(
            report.label.contains("patch creation is disabled"),
            "unexpected label: {}",
            report.label
        );
    }

    #[test]
    fn parse_reports_hdiff13_details() {
        let temp = TestDir::new();
        let patch_path = temp.child("inspect.hdiff");

        let patch = build_uncompressed_hdiff13_patch(b"old", b"newer bytes").expect("patch");
        fs::write(&patch_path, patch).expect("fixture");

        let handler = HdiffPatchHandler::new(&HDIFFPATCH);
        let report = handler
            .parse(&patch_path, &test_context_with_threads(&temp, 1))
            .expect("parse");

        assert!(report.label.contains("HDIFF13"));
        assert!(report.label.contains("cover_count=0"));
    }

    #[test]
    fn apply_rejects_source_size_mismatch() {
        let temp = TestDir::new();
        let patch = build_uncompressed_hdiff13_patch(b"old-size", b"patched").expect("patch");

        let patch_path = temp.child("mismatch.hdiff");
        let input_path = temp.child("input.bin");
        let output_path = temp.child("output.bin");

        fs::write(&patch_path, patch).expect("patch");
        fs::write(&input_path, b"tiny").expect("input");

        let handler = HdiffPatchHandler::new(&HDIFFPATCH);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context_with_threads(&temp, 1),
            )
            .expect_err("mismatch");

        assert!(error.to_string().contains("source size mismatch"));
    }

    #[test]
    fn apply_hdiff13_zero_cover_round_trip() {
        let old = b"hello old world";
        let new = b"completely new bytes";
        let patch = build_uncompressed_hdiff13_patch(old, new).expect("patch");
        let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse");

        let super::ParsedPatchVariant::SingleFile13(header) = parsed.variant else {
            panic!("expected hdiff13");
        };

        let output = apply_hdiff13(old, &parsed.bytes, &header).expect("apply");
        assert_eq!(output, new);
    }

    fn build_zstd_hdiff13_patch(old: &[u8], new: &[u8]) -> Vec<u8> {
        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 3).expect("zstd encoder");
        encoder.write_all(new).expect("zstd write");
        let compressed = encoder.finish().expect("zstd finish");
        assert!(
            compressed.len() < new.len(),
            "fixture should be compressible"
        );

        let mut patch = Vec::new();
        patch.extend_from_slice(b"HDIFF13&zstd");
        patch.push(0);

        write_var_u64(&mut patch, u64::try_from(new.len()).expect("new size"));
        write_var_u64(&mut patch, u64::try_from(old.len()).expect("old size"));
        write_var_u64(&mut patch, 0); // cover_count
        write_var_u64(&mut patch, 0); // cover_buf_size
        write_var_u64(&mut patch, 0); // compress_cover_buf_size
        write_var_u64(&mut patch, 0); // rle_ctrl_buf_size
        write_var_u64(&mut patch, 0); // compress_rle_ctrl_buf_size
        write_var_u64(&mut patch, 0); // rle_code_buf_size
        write_var_u64(&mut patch, 0); // compress_rle_code_buf_size
        write_var_u64(&mut patch, u64::try_from(new.len()).expect("new diff size"));
        write_var_u64(
            &mut patch,
            u64::try_from(compressed.len()).expect("compressed size"),
        );
        patch.extend_from_slice(&compressed);

        patch
    }

    #[test]
    fn apply_hdiff13_zstd_zero_cover_round_trip() {
        let old = b"01234567890123456789";
        let new = b"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let patch = build_zstd_hdiff13_patch(old, new);
        let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse");

        let super::ParsedPatchVariant::SingleFile13(header) = parsed.variant else {
            panic!("expected hdiff13");
        };
        assert_eq!(header.compression.as_str(), "zstd");

        let output = apply_hdiff13(old, &parsed.bytes, &header).expect("apply");
        assert_eq!(output, new);
    }

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("hdiffpatch")
            .join(name)
    }

    #[test]
    fn apply_upstream_hdiff13_codec_fixtures() {
        let source = fs::read(fixture_path("source.bin")).expect("source fixture");
        let expected = fs::read(fixture_path("target.bin")).expect("target fixture");
        let fixtures = [
            ("upstream-hdiff13-zstd.hdiff", "zstd"),
            ("upstream-hdiff13-zlib.hdiff", "zlib"),
            ("upstream-hdiff13-bz2.hdiff", "bz2"),
            ("upstream-hdiff13-lzma.hdiff", "lzma"),
            ("upstream-hdiff13-lzma2.hdiff", "lzma2"),
        ];

        for (fixture, compression) in fixtures {
            let patch = fs::read(fixture_path(fixture)).expect("patch fixture");
            let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse fixture");
            let super::ParsedPatchVariant::SingleFile13(header) = parsed.variant else {
                panic!("expected HDIFF13 variant for {fixture}");
            };

            assert_eq!(header.compression.as_str(), compression);
            let output = apply_hdiff13(&source, &parsed.bytes, &header)
                .unwrap_or_else(|error| panic!("failed to apply {fixture}: {error}"));
            assert_eq!(output, expected, "unexpected output for {fixture}");
        }
    }

    #[test]
    fn apply_upstream_hdiffsf20_zstd_fixture() {
        let source = fs::read(fixture_path("source.bin")).expect("source fixture");
        let expected = fs::read(fixture_path("target.bin")).expect("target fixture");
        let patch = fs::read(fixture_path("upstream-hdiffsf20-zstd.hpatchz")).expect("fixture");
        let parsed = super::parse_hdiff_patch_bytes(patch).expect("parse fixture");

        let super::ParsedPatchVariant::SingleStream20(header) = parsed.variant else {
            panic!("expected HDIFFSF20 variant");
        };
        assert_eq!(header.compression.as_str(), "zstd");

        let output = apply_hdiffsf20(&source, &parsed.bytes, &header).expect("apply");
        assert_eq!(output, expected);
    }
}
