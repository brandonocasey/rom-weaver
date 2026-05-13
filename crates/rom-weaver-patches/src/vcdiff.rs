use std::{
    fs::{self, File},
    io::{BufReader, Cursor, Read, Seek, SeekFrom},
    os::raw::c_int,
    path::{Path, PathBuf},
};

use rayon::prelude::*;
use rom_weaver_core::{
    FormatDescriptor, OperationContext, OperationFamily, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence, Result, RomWeaverError,
    ThreadCapability,
};
use xdelta3 as _;

const VCDIFF_MAGIC_BYTES: [u8; 3] = [0xD6, 0xC3, 0xC4];
const VCDIFF_VERSION_STANDARD: u8 = 0x00;

const HDR_SECONDARY: u8 = 0x01;
const HDR_CODE_TABLE: u8 = 0x02;
const HDR_APP_HEADER: u8 = 0x04;
const HDR_KNOWN_MASK: u8 = HDR_SECONDARY | HDR_CODE_TABLE | HDR_APP_HEADER;

const WIN_SOURCE: u8 = 0x01;
const WIN_TARGET: u8 = 0x02;
const WIN_CHECKSUM: u8 = 0x04;
const WIN_KNOWN_MASK: u8 = WIN_SOURCE | WIN_TARGET | WIN_CHECKSUM;

const DELTA_DATA_COMP: u8 = 0x01;
const DELTA_INST_COMP: u8 = 0x02;
const DELTA_ADDR_COMP: u8 = 0x04;
const DELTA_KNOWN_MASK: u8 = DELTA_DATA_COMP | DELTA_INST_COMP | DELTA_ADDR_COMP;

const SAME_MODE_START: u8 = 6;
const XD3_ADLER32_NOVER: c_int = 1 << 11;

unsafe extern "C" {
    fn xd3_decode_memory(
        input: *const u8,
        input_size: u32,
        source: *const u8,
        source_size: u32,
        output_buf: *mut u8,
        output_size: *mut u32,
        avail_output: u32,
        flags: c_int,
    ) -> c_int;
}

pub struct VcdiffPatchHandler {
    descriptor: &'static FormatDescriptor,
}

impl VcdiffPatchHandler {
    pub const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn unsupported_label(&self, operation: &str) -> String {
        format!(
            "{operation} is not implemented yet for {}",
            self.descriptor.name
        )
    }
}

impl PatchHandler for VcdiffPatchHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, _patch_path: &Path) -> ProbeConfidence {
        ProbeConfidence::Extension
    }

    fn parse(&self, patch_path: &Path, _context: &OperationContext) -> Result<OperationReport> {
        let mut reader = BufReader::new(File::open(patch_path)?);
        let patch = parse_patch(&mut reader)?;
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "parse",
            format!(
                "parsed {} patch with {} window(s)",
                self.descriptor.name,
                patch.windows.len()
            ),
            Some(1.0),
            None,
        ))
    }

    fn apply(
        &self,
        request: &PatchApplyRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        if request.patches.len() != 1 {
            return Err(RomWeaverError::Validation(format!(
                "{} apply expects exactly one patch file",
                self.descriptor.name
            )));
        }

        let patch_path = request.patches[0].clone();
        let mut patch_reader = BufReader::new(File::open(&patch_path)?);
        let patch = parse_patch(&mut patch_reader)?;
        let use_xdelta_decoder = self.descriptor.name.eq_ignore_ascii_case("xdelta")
            || patch.secondary_compressor_id.is_some();

        let requested_threads = patch.windows.len().max(1);
        let (execution, pool) =
            context.build_pool(ThreadCapability::parallel(Some(requested_threads)))?;
        let input_len = std::fs::metadata(&request.input)?.len();
        let tasks = patch
            .windows
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, window)| WindowTask {
                index,
                temp_path: context
                    .temp_paths()
                    .next_path(&format!("vcdiff-window-{index}"), Some("bin")),
                window,
            })
            .collect::<Vec<_>>();
        let patch_header = patch.header_bytes;
        let secondary_compressor_id = patch.secondary_compressor_id;
        let input_path = request.input.clone();

        let mut decoded = pool.install(|| {
            tasks
                .into_par_iter()
                .map(|task| {
                    decode_window_task(
                        &task,
                        &patch_path,
                        &input_path,
                        input_len,
                        &patch_header,
                        secondary_compressor_id,
                        use_xdelta_decoder,
                    )
                })
                .collect::<Result<Vec<_>>>()
        })?;

        decoded.sort_by_key(|window| (window.output_offset, window.index));

        let mut output = File::create(&request.output)?;
        let mut expected_offset = 0u64;
        for window in decoded {
            if window.output_offset != expected_offset {
                return Err(RomWeaverError::Validation(format!(
                    "window output offset mismatch: expected {expected_offset}, got {}",
                    window.output_offset
                )));
            }

            let mut temp = BufReader::new(File::open(&window.temp_path)?);
            std::io::copy(&mut temp, &mut output)?;
            expected_offset = checked_add(expected_offset, window.len, "assembled output size")?;
            let _ = fs::remove_file(&window.temp_path);
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "apply",
            format!(
                "applied {} patch with {} window(s)",
                self.descriptor.name,
                patch.windows.len()
            ),
            Some(1.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &PatchCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let execution = context.plan_threads(ThreadCapability::single_threaded());
        Ok(OperationReport::unsupported(
            OperationFamily::Patch,
            Some(self.descriptor.name.to_string()),
            "create",
            self.unsupported_label("create"),
            Some(execution),
        ))
    }

    fn capabilities(&self) -> PatchCapabilities {
        PatchCapabilities {
            parse: true,
            apply: true,
            create: false,
            threaded_scan: false,
            threaded_diff: false,
            threaded_output: true,
        }
    }
}

#[derive(Debug)]
struct ParsedPatch {
    header_bytes: Vec<u8>,
    secondary_compressor_id: Option<u8>,
    windows: Vec<WindowIndex>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowSourceKind {
    Source,
    Target,
}

#[derive(Clone, Debug)]
struct WindowIndex {
    win_indicator: u8,
    source_kind: Option<WindowSourceKind>,
    source_segment_size: u64,
    source_segment_position: u64,
    delta_encoding_len: u64,
    target_window_size: u64,
    delta_indicator: u8,
    checksum: Option<u32>,
    data_start: u64,
    data_len: u64,
    inst_start: u64,
    inst_len: u64,
    addr_start: u64,
    addr_len: u64,
    output_offset: u64,
}

impl WindowIndex {
    fn source_segment<R: Read + Seek>(&self, input_len: u64, reader: &mut R) -> Result<Vec<u8>> {
        match self.source_kind {
            None => Ok(Vec::new()),
            Some(WindowSourceKind::Target) => Err(RomWeaverError::Validation(
                "VCD_TARGET windows are not supported yet".into(),
            )),
            Some(WindowSourceKind::Source) => {
                let end = checked_add(
                    self.source_segment_position,
                    self.source_segment_size,
                    "source segment range",
                )?;
                if end > input_len {
                    return Err(RomWeaverError::Validation(format!(
                        "source segment [{}..{}) exceeds input length {input_len}",
                        self.source_segment_position, end
                    )));
                }

                let size = usize::try_from(self.source_segment_size).map_err(|_| {
                    RomWeaverError::Validation(
                        "source segment is too large to fit in memory on this platform".into(),
                    )
                })?;
                let mut source = vec![0; size];
                reader.seek(SeekFrom::Start(self.source_segment_position))?;
                reader.read_exact(&mut source)?;
                Ok(source)
            }
        }
    }
}

#[derive(Clone, Debug)]
struct WindowTask {
    index: usize,
    window: WindowIndex,
    temp_path: PathBuf,
}

#[derive(Debug)]
struct DecodedWindow {
    index: usize,
    output_offset: u64,
    len: u64,
    temp_path: PathBuf,
}

#[derive(Clone, Copy, Debug)]
enum TableInstruction {
    NoOp,
    Add { size: u8 },
    Run,
    Copy { size: u8, mode: u8 },
}

#[derive(Clone, Copy, Debug)]
struct CodeTableEntry {
    first: TableInstruction,
    second: TableInstruction,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AddressCache {
    near: [u64; 4],
    next_slot: usize,
    same: [u64; 3 * 256],
}

impl Default for AddressCache {
    fn default() -> Self {
        Self {
            near: [0; 4],
            next_slot: 0,
            same: [0; 3 * 256],
        }
    }
}

impl AddressCache {
    fn decode(&mut self, encoded: u64, here: u64, mode: u8) -> Result<u64> {
        let addr = match mode {
            0 => encoded,
            1 => here.checked_sub(encoded).ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "copy address underflow: encoded HERE address {encoded} exceeds current position {here}"
                ))
            })?,
            2..=5 => {
                let index = usize::from(mode - 2);
                checked_add(self.near[index], encoded, "near-cache copy address")?
            }
            6..=8 => {
                if encoded > u8::MAX.into() {
                    return Err(RomWeaverError::Validation(format!(
                        "same-cache address byte is out of range: {encoded}"
                    )));
                }
                let same_index = usize::from(mode - SAME_MODE_START) * 256 + encoded as usize;
                self.same[same_index]
            }
            _ => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported copy mode {mode}"
                )))
            }
        };

        self.update(addr);
        Ok(addr)
    }

    fn update(&mut self, addr: u64) {
        self.near[self.next_slot] = addr;
        self.next_slot = (self.next_slot + 1) % self.near.len();
        let same_index = (addr as usize) % self.same.len();
        self.same[same_index] = addr;
    }
}

fn parse_patch<R: Read + Seek>(reader: &mut R) -> Result<ParsedPatch> {
    reader.seek(SeekFrom::Start(0))?;

    let mut magic = [0; 4];
    reader.read_exact(&mut magic)?;
    if magic[..3] != VCDIFF_MAGIC_BYTES {
        return Err(RomWeaverError::Validation(
            "invalid VCDIFF header magic".into(),
        ));
    }
    if magic[3] != VCDIFF_VERSION_STANDARD {
        return Err(RomWeaverError::Validation(format!(
            "unsupported VCDIFF header version byte 0x{:02X}",
            magic[3]
        )));
    }

    let hdr_indicator = read_u8(reader)?;
    if hdr_indicator & !HDR_KNOWN_MASK != 0 {
        return Err(RomWeaverError::Validation(format!(
            "unsupported VCDIFF header flags 0x{hdr_indicator:02X}"
        )));
    }

    let secondary_compressor_id = if hdr_indicator & HDR_SECONDARY != 0 {
        Some(read_u8(reader)?)
    } else {
        None
    };

    if hdr_indicator & HDR_CODE_TABLE != 0 {
        let near = read_u8(reader)?;
        let same = read_u8(reader)?;
        let (code_table_len, _) = read_varint(reader)?;
        skip_bytes(reader, code_table_len)?;
        return Err(RomWeaverError::Validation(format!(
            "application-defined code tables are not supported yet (near={near}, same={same}, bytes={code_table_len})"
        )));
    }

    if hdr_indicator & HDR_APP_HEADER != 0 {
        let (app_header_len, _) = read_varint(reader)?;
        skip_bytes(reader, app_header_len)?;
    }

    let header_end = reader.stream_position()?;
    let header_bytes = read_section(reader, 0, header_end)?;
    reader.seek(SeekFrom::Start(header_end))?;

    let mut windows = Vec::new();
    let mut output_offset = 0u64;
    while let Some(window) = read_window_index(reader, output_offset)? {
        output_offset = checked_add(
            output_offset,
            window.target_window_size,
            "patch output size",
        )?;
        windows.push(window);
    }

    Ok(ParsedPatch {
        header_bytes,
        secondary_compressor_id,
        windows,
    })
}

fn read_window_index<R: Read + Seek>(
    reader: &mut R,
    output_offset: u64,
) -> Result<Option<WindowIndex>> {
    let Some(win_indicator) = read_optional_u8(reader)? else {
        return Ok(None);
    };

    if win_indicator & !WIN_KNOWN_MASK != 0 {
        return Err(RomWeaverError::Validation(format!(
            "unsupported window flags 0x{win_indicator:02X}"
        )));
    }

    let uses_source = win_indicator & WIN_SOURCE != 0;
    let uses_target = win_indicator & WIN_TARGET != 0;
    if uses_source && uses_target {
        return Err(RomWeaverError::Validation(
            "window cannot reference both VCD_SOURCE and VCD_TARGET".into(),
        ));
    }

    let source_kind = if uses_source {
        Some(WindowSourceKind::Source)
    } else if uses_target {
        Some(WindowSourceKind::Target)
    } else {
        None
    };

    let (source_segment_size, source_segment_position) = if source_kind.is_some() {
        let (size, _) = read_varint(reader)?;
        let (position, _) = read_varint(reader)?;
        (size, position)
    } else {
        (0, 0)
    };

    let (delta_encoding_len, _) = read_varint(reader)?;
    let delta_encoding_start = reader.stream_position()?;

    let (target_window_size, _) = read_varint(reader)?;
    let delta_indicator = read_u8(reader)?;
    if delta_indicator & !DELTA_KNOWN_MASK != 0 {
        return Err(RomWeaverError::Validation(format!(
            "unsupported delta section flags 0x{delta_indicator:02X}"
        )));
    }

    let (data_len, _) = read_varint(reader)?;
    let (inst_len, _) = read_varint(reader)?;
    let (addr_len, _) = read_varint(reader)?;

    let checksum = if win_indicator & WIN_CHECKSUM != 0 {
        Some(read_be_u32(reader)?)
    } else {
        None
    };

    let data_start = reader.stream_position()?;
    let inst_start = checked_add(data_start, data_len, "instruction section start")?;
    let addr_start = checked_add(inst_start, inst_len, "address section start")?;
    let window_end = checked_add(addr_start, addr_len, "window end")?;

    let header_and_sections = checked_add(
        data_start - delta_encoding_start,
        checked_add(
            data_len,
            checked_add(inst_len, addr_len, "window section size")?,
            "window section size",
        )?,
        "delta encoding size",
    )?;
    if header_and_sections != delta_encoding_len {
        return Err(RomWeaverError::Validation(format!(
            "delta encoding length mismatch: header declared {delta_encoding_len} bytes but window needs {header_and_sections}"
        )));
    }

    if matches!(source_kind, Some(WindowSourceKind::Target)) {
        return Err(RomWeaverError::Validation(
            "VCD_TARGET windows are not supported yet".into(),
        ));
    }

    reader.seek(SeekFrom::Start(window_end))?;

    Ok(Some(WindowIndex {
        win_indicator,
        source_kind,
        source_segment_size,
        source_segment_position,
        delta_encoding_len,
        target_window_size,
        delta_indicator,
        checksum,
        data_start,
        data_len,
        inst_start,
        inst_len,
        addr_start,
        addr_len,
        output_offset,
    }))
}

fn decode_window_task(
    task: &WindowTask,
    patch_path: &Path,
    input_path: &Path,
    input_len: u64,
    patch_header: &[u8],
    secondary_compressor_id: Option<u8>,
    use_xdelta_decoder: bool,
) -> Result<DecodedWindow> {
    let mut input_reader = BufReader::new(File::open(input_path)?);
    let source = task.window.source_segment(input_len, &mut input_reader)?;
    let target = if window_requires_xdelta_fallback(
        &task.window,
        secondary_compressor_id,
        use_xdelta_decoder,
    ) {
        let mut patch_reader = BufReader::new(File::open(patch_path)?);
        decode_window_with_xdelta(&mut patch_reader, patch_header, &task.window, &source)?
    } else {
        let mut patch_reader = BufReader::new(File::open(patch_path)?);
        decode_window(&mut patch_reader, &task.window, &source)?
    };

    if let Some(parent) = task.temp_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&task.temp_path, &target)?;

    Ok(DecodedWindow {
        index: task.index,
        output_offset: task.window.output_offset,
        len: target.len() as u64,
        temp_path: task.temp_path.clone(),
    })
}

fn window_requires_xdelta_fallback(
    window: &WindowIndex,
    secondary_compressor_id: Option<u8>,
    use_xdelta_decoder: bool,
) -> bool {
    use_xdelta_decoder || (secondary_compressor_id.is_some() && window.delta_indicator != 0)
}

fn decode_window_with_xdelta<R: Read + Seek>(
    patch_reader: &mut R,
    patch_header: &[u8],
    window: &WindowIndex,
    source_segment: &[u8],
) -> Result<Vec<u8>> {
    let patch_bytes = build_single_window_patch(patch_reader, patch_header, window)?;
    let decoded = decode_window_with_xdelta_memory(&patch_bytes, source_segment, window)?;

    if decoded.len() as u64 != window.target_window_size {
        return Err(RomWeaverError::Validation(format!(
            "xdelta fallback decoded {} byte(s) but expected {}",
            decoded.len(),
            window.target_window_size
        )));
    }

    if let Some(expected) = window.checksum {
        let actual = adler32(&decoded);
        if actual != expected {
            return Err(RomWeaverError::Validation(format!(
                "target window checksum mismatch: expected 0x{expected:08X}, got 0x{actual:08X}"
            )));
        }
    }

    Ok(decoded)
}

fn decode_window_with_xdelta_memory(
    patch_bytes: &[u8],
    source_segment: &[u8],
    window: &WindowIndex,
) -> Result<Vec<u8>> {
    let patch_len = u32::try_from(patch_bytes.len()).map_err(|_| {
        RomWeaverError::Validation("xdelta fallback patch window is too large".into())
    })?;
    let source_len = u32::try_from(source_segment.len()).map_err(|_| {
        RomWeaverError::Validation("xdelta fallback source window is too large".into())
    })?;
    let expected_len = u32::try_from(window.target_window_size).map_err(|_| {
        RomWeaverError::Validation("xdelta fallback output window is too large".into())
    })?;
    let output_capacity = usize::try_from(expected_len).map_err(|_| {
        RomWeaverError::Validation("xdelta fallback output window is too large".into())
    })?;
    let mut output = vec![0; output_capacity.max(1)];
    let mut output_len = expected_len;

    let rc = unsafe {
        xd3_decode_memory(
            patch_bytes.as_ptr(),
            patch_len,
            source_segment.as_ptr(),
            source_len,
            output.as_mut_ptr(),
            &mut output_len,
            expected_len.max(1),
            XD3_ADLER32_NOVER,
        )
    };
    if rc != 0 {
        return Err(RomWeaverError::Validation(format!(
            "xdelta fallback failed to decode window at output offset {} (code {rc})",
            window.output_offset
        )));
    }

    output.truncate(output_len as usize);
    Ok(output)
}

fn build_single_window_patch<R: Read + Seek>(
    patch_reader: &mut R,
    patch_header: &[u8],
    window: &WindowIndex,
) -> Result<Vec<u8>> {
    let data = read_section(patch_reader, window.data_start, window.data_len)?;
    let inst = read_section(patch_reader, window.inst_start, window.inst_len)?;
    let addr = read_section(patch_reader, window.addr_start, window.addr_len)?;

    let mut patch = patch_header.to_vec();
    patch.push(window.win_indicator);
    if window.source_kind.is_some() {
        encode_varint(&mut patch, window.source_segment_size);
        encode_varint(&mut patch, 0);
    }
    encode_varint(&mut patch, window.delta_encoding_len);
    encode_varint(&mut patch, window.target_window_size);
    patch.push(window.delta_indicator);
    encode_varint(&mut patch, window.data_len);
    encode_varint(&mut patch, window.inst_len);
    encode_varint(&mut patch, window.addr_len);
    if let Some(checksum) = window.checksum {
        patch.extend_from_slice(&checksum.to_be_bytes());
    }
    patch.extend_from_slice(&data);
    patch.extend_from_slice(&inst);
    patch.extend_from_slice(&addr);
    Ok(patch)
}

fn decode_window<R: Read + Seek>(
    patch_reader: &mut R,
    window: &WindowIndex,
    source_segment: &[u8],
) -> Result<Vec<u8>> {
    if window.delta_indicator != 0 {
        return Err(RomWeaverError::Validation(
            "native VCDIFF decoder cannot read secondary-compressed sections".into(),
        ));
    }

    let data = read_section(patch_reader, window.data_start, window.data_len)?;
    let inst = read_section(patch_reader, window.inst_start, window.inst_len)?;
    let addr = read_section(patch_reader, window.addr_start, window.addr_len)?;

    let mut data_offset = 0usize;
    let mut inst_cursor = Cursor::new(inst);
    let mut addr_cursor = Cursor::new(addr);
    let mut output =
        Vec::with_capacity(usize::try_from(window.target_window_size).map_err(|_| {
            RomWeaverError::Validation(
                "target window is too large to fit in memory on this platform".into(),
            )
        })?);
    let mut cache = AddressCache::default();
    let code_table = build_default_code_table();
    let source_len = source_segment.len() as u64;

    while inst_cursor.position() < window.inst_len {
        let opcode = read_u8(&mut inst_cursor)?;
        let entry = code_table[opcode as usize];
        execute_instruction(
            entry.first,
            &mut inst_cursor,
            &mut addr_cursor,
            &data,
            &mut data_offset,
            source_segment,
            source_len,
            &mut output,
            window.target_window_size,
            &mut cache,
        )?;
        execute_instruction(
            entry.second,
            &mut inst_cursor,
            &mut addr_cursor,
            &data,
            &mut data_offset,
            source_segment,
            source_len,
            &mut output,
            window.target_window_size,
            &mut cache,
        )?;
    }

    if data_offset != data.len() {
        return Err(RomWeaverError::Validation(format!(
            "window left {} data byte(s) unread",
            data.len() - data_offset
        )));
    }
    if addr_cursor.position() != window.addr_len {
        return Err(RomWeaverError::Validation(format!(
            "window left {} address byte(s) unread",
            window.addr_len - addr_cursor.position()
        )));
    }
    if output.len() as u64 != window.target_window_size {
        return Err(RomWeaverError::Validation(format!(
            "window decoded {} byte(s) but expected {}",
            output.len(),
            window.target_window_size
        )));
    }

    if let Some(expected) = window.checksum {
        let actual = adler32(&output);
        if actual != expected {
            return Err(RomWeaverError::Validation(format!(
                "target window checksum mismatch: expected 0x{expected:08X}, got 0x{actual:08X}"
            )));
        }
    }

    Ok(output)
}

#[allow(clippy::too_many_arguments)]
fn execute_instruction(
    instruction: TableInstruction,
    inst_cursor: &mut Cursor<Vec<u8>>,
    addr_cursor: &mut Cursor<Vec<u8>>,
    data: &[u8],
    data_offset: &mut usize,
    source_segment: &[u8],
    source_len: u64,
    output: &mut Vec<u8>,
    target_window_size: u64,
    cache: &mut AddressCache,
) -> Result<()> {
    let (kind, size) = match instruction {
        TableInstruction::NoOp => return Ok(()),
        TableInstruction::Add { size } => ("ADD", size),
        TableInstruction::Run => ("RUN", 0),
        TableInstruction::Copy { size, .. } => ("COPY", size),
    };

    let len = if size == 0 && kind != "RUN" {
        read_varint(inst_cursor)?.0
    } else if kind == "RUN" {
        read_varint(inst_cursor)?.0
    } else {
        u64::from(size)
    };

    let new_output_len = checked_add(output.len() as u64, len, "target window size")?;
    if new_output_len > target_window_size {
        return Err(RomWeaverError::Validation(format!(
            "{kind} would decode past the end of the target window ({new_output_len} > {target_window_size})"
        )));
    }

    match instruction {
        TableInstruction::NoOp => Ok(()),
        TableInstruction::Add { .. } => {
            let len = usize::try_from(len).map_err(|_| {
                RomWeaverError::Validation("ADD instruction is too large for this platform".into())
            })?;
            let end = data_offset.checked_add(len).ok_or_else(|| {
                RomWeaverError::Validation("ADD instruction overflowed the data section".into())
            })?;
            let literal = data.get(*data_offset..end).ok_or_else(|| {
                RomWeaverError::Validation(
                    "ADD instruction reads past the end of the data section".into(),
                )
            })?;
            output.extend_from_slice(literal);
            *data_offset = end;
            Ok(())
        }
        TableInstruction::Run => {
            let byte = data.get(*data_offset).copied().ok_or_else(|| {
                RomWeaverError::Validation(
                    "RUN instruction reads past the end of the data section".into(),
                )
            })?;
            *data_offset += 1;
            output.extend(std::iter::repeat_n(
                byte,
                usize::try_from(len).map_err(|_| {
                    RomWeaverError::Validation(
                        "RUN instruction is too large for this platform".into(),
                    )
                })?,
            ));
            Ok(())
        }
        TableInstruction::Copy { mode, .. } => {
            let encoded_addr = if mode >= SAME_MODE_START {
                u64::from(read_u8(addr_cursor)?)
            } else {
                read_varint(addr_cursor)?.0
            };
            let here = checked_add(source_len, output.len() as u64, "copy HERE position")?;
            let addr = cache.decode(encoded_addr, here, mode)?;
            if addr >= here {
                return Err(RomWeaverError::Validation(format!(
                    "COPY address {addr} is not before current position {here}"
                )));
            }

            if addr < source_len {
                let source_end = checked_add(addr, len, "COPY source range")?;
                if source_end > source_len {
                    return Err(RomWeaverError::Validation(format!(
                        "COPY range [{addr}..{source_end}) crosses from source into target"
                    )));
                }
                let start = usize::try_from(addr).map_err(|_| {
                    RomWeaverError::Validation("COPY address is too large for this platform".into())
                })?;
                let end = usize::try_from(source_end).map_err(|_| {
                    RomWeaverError::Validation("COPY address is too large for this platform".into())
                })?;
                output.extend_from_slice(&source_segment[start..end]);
                return Ok(());
            }

            let start = usize::try_from(addr - source_len).map_err(|_| {
                RomWeaverError::Validation(
                    "COPY target address is too large for this platform".into(),
                )
            })?;
            let copy_len = usize::try_from(len).map_err(|_| {
                RomWeaverError::Validation("COPY instruction is too large for this platform".into())
            })?;
            for offset in 0..copy_len {
                let byte = *output.get(start + offset).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "COPY range starts outside the decoded target window at offset {}",
                        start + offset
                    ))
                })?;
                output.push(byte);
            }
            Ok(())
        }
    }
}

fn build_default_code_table() -> [CodeTableEntry; 256] {
    let mut table = [CodeTableEntry {
        first: TableInstruction::NoOp,
        second: TableInstruction::NoOp,
    }; 256];

    table[0] = CodeTableEntry {
        first: TableInstruction::Run,
        second: TableInstruction::NoOp,
    };

    for (index, size) in (0u8..=17).enumerate() {
        table[index + 1] = CodeTableEntry {
            first: TableInstruction::Add { size },
            second: TableInstruction::NoOp,
        };
    }

    for mode in 0u8..=8 {
        for size_index in 0u8..=15 {
            let index = 19 + usize::from(mode) * 16 + usize::from(size_index);
            table[index] = CodeTableEntry {
                first: TableInstruction::Copy {
                    size: if size_index == 0 { 0 } else { size_index + 3 },
                    mode,
                },
                second: TableInstruction::NoOp,
            };
        }
    }

    let mut index = 163usize;
    for add_size in 1u8..=4 {
        for copy_mode in 0u8..=5 {
            for copy_size in 4u8..=6 {
                table[index] = CodeTableEntry {
                    first: TableInstruction::Add { size: add_size },
                    second: TableInstruction::Copy {
                        size: copy_size,
                        mode: copy_mode,
                    },
                };
                index += 1;
            }
        }
    }

    for add_size in 1u8..=4 {
        for copy_mode in 6u8..=8 {
            table[index] = CodeTableEntry {
                first: TableInstruction::Add { size: add_size },
                second: TableInstruction::Copy {
                    size: 4,
                    mode: copy_mode,
                },
            };
            index += 1;
        }
    }

    for mode in 0u8..=8 {
        table[index] = CodeTableEntry {
            first: TableInstruction::Copy { size: 4, mode },
            second: TableInstruction::Add { size: 1 },
        };
        index += 1;
    }

    table
}

fn read_section<R: Read + Seek>(reader: &mut R, start: u64, len: u64) -> Result<Vec<u8>> {
    let size = usize::try_from(len).map_err(|_| {
        RomWeaverError::Validation("section is too large to fit in memory on this platform".into())
    })?;
    let mut buffer = vec![0; size];
    reader.seek(SeekFrom::Start(start))?;
    reader.read_exact(&mut buffer)?;
    Ok(buffer)
}

fn skip_bytes<R: Read>(reader: &mut R, len: u64) -> Result<()> {
    let size = usize::try_from(len).map_err(|_| {
        RomWeaverError::Validation("section is too large to fit in memory on this platform".into())
    })?;
    let mut buffer = vec![0; size];
    reader.read_exact(&mut buffer)?;
    Ok(())
}

fn read_optional_u8<R: Read>(reader: &mut R) -> Result<Option<u8>> {
    let mut buffer = [0; 1];
    match reader.read_exact(&mut buffer) {
        Ok(()) => Ok(Some(buffer[0])),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn read_u8<R: Read>(reader: &mut R) -> Result<u8> {
    let mut buffer = [0; 1];
    reader.read_exact(&mut buffer)?;
    Ok(buffer[0])
}

fn read_be_u32<R: Read>(reader: &mut R) -> Result<u32> {
    let mut buffer = [0; 4];
    reader.read_exact(&mut buffer)?;
    Ok(u32::from_be_bytes(buffer))
}

fn read_varint<R: Read>(reader: &mut R) -> Result<(u64, usize)> {
    let mut value = 0u64;
    let mut count = 0usize;
    loop {
        let byte = read_u8(reader)?;
        count += 1;
        value = value
            .checked_mul(128)
            .and_then(|current| current.checked_add(u64::from(byte & 0x7F)))
            .ok_or_else(|| RomWeaverError::Validation("base-128 integer overflowed u64".into()))?;
        if byte & 0x80 == 0 {
            break;
        }
        if count >= 10 {
            return Err(RomWeaverError::Validation(
                "base-128 integer exceeds the supported length".into(),
            ));
        }
    }
    Ok((value, count))
}

fn encode_varint(bytes: &mut Vec<u8>, mut value: u64) {
    if value == 0 {
        bytes.push(0);
        return;
    }

    let mut stack = Vec::new();
    while value > 0 {
        stack.push((value % 128) as u8);
        value /= 128;
    }

    for (index, digit) in stack.iter().rev().enumerate() {
        let is_last = index + 1 == stack.len();
        bytes.push(if is_last { *digit } else { *digit | 0x80 });
    }
}

fn checked_add(lhs: u64, rhs: u64, label: &str) -> Result<u64> {
    lhs.checked_add(rhs)
        .ok_or_else(|| RomWeaverError::Validation(format!("{label} overflowed u64")))
}

fn adler32(bytes: &[u8]) -> u32 {
    const MOD_ADLER: u32 = 65_521;
    let mut a = 1u32;
    let mut b = 0u32;
    for &byte in bytes {
        a = (a + u32::from(byte)) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    (b << 16) | a
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Cursor,
        os::raw::c_int,
        path::PathBuf,
        process,
        sync::Arc,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use rom_weaver_core::{CancellationToken, NoopProgressSink, ThreadBudget};

    use super::*;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);
    const XD3_SEC_FGK: c_int = 1 << 6;
    const XD3_ADLER32: c_int = 1 << 10;
    const XD3_NOCOMPRESS: c_int = 1 << 13;

    unsafe extern "C" {
        fn xd3_encode_memory(
            input: *const u8,
            input_size: u32,
            source: *const u8,
            source_size: u32,
            output_buffer: *mut u8,
            output_size: *mut u32,
            avail_output: u32,
            flags: c_int,
        ) -> c_int;
    }

    #[derive(Clone)]
    struct TestWindow {
        win_indicator: u8,
        source_segment_size: Option<u64>,
        source_segment_position: Option<u64>,
        target_window_size: u64,
        checksum: Option<u32>,
        data: Vec<u8>,
        inst: Vec<u8>,
        addr: Vec<u8>,
    }

    #[derive(Default)]
    struct TestPatch {
        version: u8,
        header_flags: u8,
        secondary_id: Option<u8>,
        code_table_near: Option<u8>,
        code_table_same: Option<u8>,
        code_table_data: Vec<u8>,
        app_header: Vec<u8>,
        windows: Vec<TestWindow>,
    }

    #[test]
    fn parse_and_apply_basic_source_patch() {
        let input = b"hello old world";
        let expected = b"hello new world";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: expected.len() as u64,
                checksum: None,
                data: b"new".to_vec(),
                inst: vec![22, 4, 22],
                addr: encode_all_varints(&[0, 9]),
            }],
            ..Default::default()
        });

        let mut reader = Cursor::new(&patch_bytes);
        let parsed = parse_patch(&mut reader).expect("parse patch");
        assert_eq!(parsed.windows.len(), 1);

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path.clone(),
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_supports_overlapping_target_copy() {
        let patch_bytes = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: 0,
                source_segment_size: None,
                source_segment_position: None,
                target_window_size: 9,
                checksum: None,
                data: b"abc".to_vec(),
                inst: vec![4, 22],
                addr: encode_all_varints(&[0]),
            }],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, b"unused").expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply patch");

        assert_eq!(fs::read(output_path).expect("read output"), b"abcabcabc");
    }

    #[test]
    fn parse_supports_xdelta_app_header_and_checksum() {
        let input = b"abcabcabcabc";
        let expected = b"abcabcZZabcabc";
        let checksum = adler32(expected);
        let patch_bytes = build_patch(TestPatch {
            header_flags: HDR_APP_HEADER,
            app_header: b"xdelta-test".to_vec(),
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE | WIN_CHECKSUM,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: expected.len() as u64,
                checksum: Some(checksum),
                data: b"ZZ".to_vec(),
                inst: vec![22, 3, 22],
                addr: encode_all_varints(&[0, 6]),
            }],
            ..Default::default()
        });

        let mut reader = Cursor::new(&patch_bytes);
        let parsed = parse_patch(&mut reader).expect("parse patch");
        assert_eq!(parsed.windows.len(), 1);
        assert_eq!(parsed.windows[0].checksum, Some(checksum));

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .parse(&patch_path, &test_context())
            .expect("inspect patch");
        assert_eq!(report.status, rom_weaver_core::OperationStatus::Succeeded);

        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn parse_rejects_vcd_target_windows() {
        let patch_bytes = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: WIN_TARGET,
                source_segment_size: Some(3),
                source_segment_position: Some(0),
                target_window_size: 3,
                checksum: None,
                data: Vec::new(),
                inst: vec![4],
                addr: Vec::new(),
            }],
            ..Default::default()
        });

        let error = parse_patch(&mut Cursor::new(patch_bytes)).expect_err("unsupported target");
        assert!(format!("{error}").contains("VCD_TARGET"));
    }

    #[test]
    fn parse_supports_secondary_fixture() {
        let patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");

        let parsed = parse_patch(&mut Cursor::new(patch)).expect("parse secondary patch");
        assert!(parsed.secondary_compressor_id.is_some());
        assert_eq!(parsed.windows.len(), 1);
        assert!(
            parsed
                .windows
                .iter()
                .any(|window| window.delta_indicator != 0)
        );
    }

    #[test]
    fn parse_rejects_custom_code_tables() {
        let patch_bytes = build_patch(TestPatch {
            header_flags: HDR_CODE_TABLE,
            code_table_near: Some(4),
            code_table_same: Some(3),
            code_table_data: vec![0x00],
            ..Default::default()
        });

        let error = parse_patch(&mut Cursor::new(patch_bytes)).expect_err("unsupported code table");
        assert!(format!("{error}").contains("application-defined code tables"));
    }

    #[test]
    fn apply_fails_on_checksum_mismatch() {
        let input = b"abcabcabcabc";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![TestWindow {
                win_indicator: WIN_SOURCE | WIN_CHECKSUM,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: 6,
                checksum: Some(0xDEADBEEF),
                data: Vec::new(),
                inst: vec![22],
                addr: encode_all_varints(&[0]),
            }],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("checksum mismatch");
        assert!(format!("{error}").contains("checksum mismatch"));
    }

    #[test]
    fn apply_rejects_multiple_patch_files() {
        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: PathBuf::from("input.bin"),
                    patches: vec![PathBuf::from("a.vcdiff"), PathBuf::from("b.vcdiff")],
                    output: PathBuf::from("output.bin"),
                },
                &test_context(),
            )
            .expect_err("multiple patches");
        assert!(format!("{error}").contains("exactly one patch"));
    }

    #[test]
    fn multi_window_patch_round_trips() {
        let input = b"hello old world";
        let expected = b"hello new world";
        let patch_bytes = build_patch(TestPatch {
            windows: vec![
                TestWindow {
                    win_indicator: WIN_SOURCE,
                    source_segment_size: Some(input.len() as u64),
                    source_segment_position: Some(0),
                    target_window_size: 6,
                    checksum: None,
                    data: Vec::new(),
                    inst: vec![22],
                    addr: encode_all_varints(&[0]),
                },
                TestWindow {
                    win_indicator: WIN_SOURCE,
                    source_segment_size: Some(input.len() as u64),
                    source_segment_position: Some(0),
                    target_window_size: 9,
                    checksum: None,
                    data: b"new".to_vec(),
                    inst: vec![4, 22],
                    addr: encode_all_varints(&[9]),
                },
            ],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.vcdiff");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::VCDIFF);
        let inspect = handler
            .parse(&patch_path, &test_context())
            .expect("inspect patch");
        assert_eq!(inspect.status, rom_weaver_core::OperationStatus::Succeeded);
        assert!(inspect.label.contains("2 window"));

        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(4),
            )
            .expect("apply patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn multi_window_xdelta_patch_round_trips_with_parallel_decoder() {
        let input = b"hello old world";
        let expected = b"hello new world";
        let patch_bytes = build_patch(TestPatch {
            app_header: b"xdelta-cli".to_vec(),
            windows: vec![
                TestWindow {
                    win_indicator: WIN_SOURCE,
                    source_segment_size: Some(input.len() as u64),
                    source_segment_position: Some(0),
                    target_window_size: 6,
                    checksum: None,
                    data: Vec::new(),
                    inst: vec![22],
                    addr: encode_all_varints(&[0]),
                },
                TestWindow {
                    win_indicator: WIN_SOURCE,
                    source_segment_size: Some(input.len() as u64),
                    source_segment_position: Some(0),
                    target_window_size: 9,
                    checksum: None,
                    data: b"new".to_vec(),
                    inst: vec![4, 22],
                    addr: encode_all_varints(&[9]),
                },
            ],
            ..Default::default()
        });

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(4),
            )
            .expect("apply xdelta patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(execution.used_parallelism);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn secondary_fixture_applies_with_parallel_fallback() {
        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::copy(fixture_path("secondary-djw.xdelta"), &patch_path).expect("copy patch fixture");
        let expected = fs::read(fixture_path("secondary-target.bin")).expect("read target fixture");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let inspect = handler
            .parse(&patch_path, &test_context())
            .expect("inspect secondary patch");
        assert_eq!(inspect.status, rom_weaver_core::OperationStatus::Succeeded);

        let report = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context_with_threads(8),
            )
            .expect("apply secondary patch");
        let execution = report.thread_execution.expect("thread execution");
        assert!(!execution.used_parallelism);
        assert_eq!(execution.effective_threads, 1);
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn generated_fgk_secondary_patch_round_trips() {
        let (input, expected) = generated_secondary_source_and_target();
        let patch_bytes = encode_secondary_patch(
            &input,
            &expected,
            XD3_SEC_FGK | XD3_ADLER32 | XD3_NOCOMPRESS,
        );

        let parsed = parse_patch(&mut Cursor::new(&patch_bytes)).expect("parse fgk patch");
        assert_eq!(parsed.secondary_compressor_id, Some(16));
        assert!(
            parsed
                .windows
                .iter()
                .any(|window| window.delta_indicator != 0)
        );

        let temp = create_temp_dir();
        let input_path = temp.join("input.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::write(&input_path, &input).expect("write input");
        fs::write(&patch_path, patch_bytes).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path.clone(),
                },
                &test_context(),
            )
            .expect("apply fgk patch");
        assert_eq!(fs::read(output_path).expect("read output"), expected);
    }

    #[test]
    fn apply_fails_for_unknown_secondary_compressor_id() {
        let mut patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");
        patch[5] = 0x7F;

        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse unknown secondary patch");
        assert_eq!(parsed.secondary_compressor_id, Some(0x7F));

        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::write(&patch_path, patch).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("unknown secondary compressor should fail");
        assert!(format!("{error}").contains("xdelta fallback failed"));
    }

    #[test]
    fn apply_fails_for_corrupted_secondary_stream() {
        let mut patch =
            fs::read(fixture_path("secondary-djw.xdelta")).expect("read secondary patch fixture");
        let parsed = parse_patch(&mut Cursor::new(&patch)).expect("parse secondary patch");
        let data_offset = parsed.windows[0].data_start as usize;
        patch[data_offset + 8] ^= 0x20;

        let temp = create_temp_dir();
        let input_path = temp.join("source.bin");
        let patch_path = temp.join("update.xdelta");
        let output_path = temp.join("output.bin");
        fs::copy(fixture_path("secondary-source.bin"), &input_path).expect("copy source fixture");
        fs::write(&patch_path, patch).expect("write patch");

        let handler = VcdiffPatchHandler::new(&crate::XDELTA);
        let error = handler
            .apply(
                &PatchApplyRequest {
                    input: input_path,
                    patches: vec![patch_path],
                    output: output_path,
                },
                &test_context(),
            )
            .expect_err("corrupted secondary stream should fail");
        let message = format!("{error}");
        assert!(
            message.contains("xdelta fallback failed") || message.contains("checksum mismatch")
        );
    }

    fn create_temp_dir() -> PathBuf {
        let unique = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "rom-weaver-vcdiff-tests-{}-{timestamp}-{unique}",
            process::id()
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn test_context() -> OperationContext {
        test_context_with_threads(1)
    }

    fn test_context_with_threads(threads: usize) -> OperationContext {
        OperationContext::new(
            ThreadBudget::Fixed(threads),
            std::env::temp_dir().join("rom-weaver-vcdiff-tests"),
            Arc::new(NoopProgressSink),
            CancellationToken::new(),
        )
    }

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/vcdiff")
            .join(name)
    }

    fn generated_secondary_source_and_target() -> (Vec<u8>, Vec<u8>) {
        let source: Vec<u8> = (0..65_536)
            .map(|index| ((index * 31) & 0xFF) as u8)
            .collect();
        let mut target = Vec::new();
        let chunk = b"PATCH-DATA-BLOCK-ALPHA-BETA-GAMMA-";
        while target.len() < 70_000 {
            target.extend_from_slice(chunk);
            target.extend_from_slice(format!("{:04}", target.len() % 10_000).as_bytes());
        }
        target.truncate(70_000);
        (source, target)
    }

    fn encode_secondary_patch(source: &[u8], target: &[u8], flags: c_int) -> Vec<u8> {
        let input_len = u32::try_from(target.len()).expect("target too large for xdelta encode");
        let source_len = u32::try_from(source.len()).expect("source too large for xdelta encode");
        let capacity = (target.len() + source.len())
            .checked_mul(8)
            .and_then(|value| value.checked_add(4096))
            .expect("encode capacity overflow");
        let mut output = vec![0; capacity];
        let mut output_size = u32::try_from(output.len()).expect("encode buffer too large");

        let rc = unsafe {
            xd3_encode_memory(
                target.as_ptr(),
                input_len,
                source.as_ptr(),
                source_len,
                output.as_mut_ptr(),
                &mut output_size,
                output_size,
                flags,
            )
        };
        assert_eq!(rc, 0, "xdelta encoder failed with code {rc}");
        output.truncate(output_size as usize);
        output
    }

    fn build_patch(patch: TestPatch) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&VCDIFF_MAGIC_BYTES);
        bytes.push(patch.version);
        bytes.push(patch.header_flags);

        if patch.header_flags & HDR_SECONDARY != 0 {
            bytes.push(patch.secondary_id.expect("secondary id"));
        }
        if patch.header_flags & HDR_CODE_TABLE != 0 {
            bytes.push(patch.code_table_near.expect("near size"));
            bytes.push(patch.code_table_same.expect("same size"));
            encode_varint(&mut bytes, patch.code_table_data.len() as u64);
            bytes.extend_from_slice(&patch.code_table_data);
        }
        if patch.header_flags & HDR_APP_HEADER != 0 {
            encode_varint(&mut bytes, patch.app_header.len() as u64);
            bytes.extend_from_slice(&patch.app_header);
        }

        for window in patch.windows {
            bytes.push(window.win_indicator);
            if let (Some(size), Some(position)) =
                (window.source_segment_size, window.source_segment_position)
            {
                encode_varint(&mut bytes, size);
                encode_varint(&mut bytes, position);
            }

            let mut delta = Vec::new();
            encode_varint(&mut delta, window.target_window_size);
            delta.push(0);
            encode_varint(&mut delta, window.data.len() as u64);
            encode_varint(&mut delta, window.inst.len() as u64);
            encode_varint(&mut delta, window.addr.len() as u64);
            if let Some(checksum) = window.checksum {
                delta.extend_from_slice(&checksum.to_be_bytes());
            }
            delta.extend_from_slice(&window.data);
            delta.extend_from_slice(&window.inst);
            delta.extend_from_slice(&window.addr);

            encode_varint(&mut bytes, delta.len() as u64);
            bytes.extend_from_slice(&delta);
        }

        bytes
    }

    fn encode_all_varints(values: &[u64]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for &value in values {
            encode_varint(&mut bytes, value);
        }
        bytes
    }

    fn encode_varint(bytes: &mut Vec<u8>, mut value: u64) {
        if value == 0 {
            bytes.push(0);
            return;
        }

        let mut stack = Vec::new();
        while value > 0 {
            stack.push((value % 128) as u8);
            value /= 128;
        }

        for (index, digit) in stack.iter().rev().enumerate() {
            let is_last = index + 1 == stack.len();
            bytes.push(if is_last { *digit } else { *digit | 0x80 });
        }
    }
}
