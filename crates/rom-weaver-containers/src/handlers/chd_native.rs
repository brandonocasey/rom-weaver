mod chd_native {
    use super::*;

    pub(super) struct ChdContainerHandler;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct HdGeometry {
        cylinders: u32,
        heads: u32,
        sectors: u32,
        bytes_per_sector: u32,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct DiscLayout {
        kind: DiscKind,
        tracks: Vec<DiscTrack>,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct AvProfile {
        frame_bytes: u32,
        fps: u32,
        fpsfrac: u32,
        width: u32,
        height: u32,
        interlaced: u32,
        channels: u32,
        sample_rate: u32,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct DiscTrack {
        number: u32,
        mode: DiscTrackMode,
        file_path: PathBuf,
        file_offset_bytes: u64,
        frames: u32,
        pregap_frames: u32,
        postgap_frames: u32,
        pregap_has_data: bool,
        has_subcode: bool,
        pad_frames: u32,
        swap_audio_on_read: bool,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum DiscKind {
        CdRom,
        GdRom,
    }

    impl DiscKind {
        fn metadata_tag(self) -> u32 {
            match self {
                Self::CdRom => CDROM_TRACK_METADATA2_TAG,
                Self::GdRom => GDROM_TRACK_METADATA_TAG,
            }
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum DiscTrackMode {
        Mode1,
        Mode1Raw,
        Mode2,
        Mode2Form1,
        Mode2Form2,
        Mode2FormMix,
        Mode2Raw,
        Audio,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum FlacSampleByteOrder {
        LittleEndian,
        BigEndian,
    }

    impl DiscTrackMode {
        fn cue_label(self) -> &'static str {
            match self {
                Self::Mode1 => "MODE1/2048",
                Self::Mode1Raw => "MODE1/2352",
                Self::Mode2 => "MODE2/2336",
                Self::Mode2Form1 => "MODE2/2048",
                Self::Mode2Form2 => "MODE2/2324",
                Self::Mode2FormMix => "MODE2_FORM_MIX",
                Self::Mode2Raw => "MODE2/2352",
                Self::Audio => "AUDIO",
            }
        }

        fn metadata_label(self) -> &'static str {
            match self {
                Self::Mode1 => "MODE1",
                Self::Mode1Raw => "MODE1_RAW",
                Self::Mode2 => "MODE2",
                Self::Mode2Form1 => "MODE2_FORM1",
                Self::Mode2Form2 => "MODE2_FORM2",
                Self::Mode2FormMix => "MODE2_FORM_MIX",
                Self::Mode2Raw => "MODE2_RAW",
                Self::Audio => "AUDIO",
            }
        }

        fn data_bytes(self) -> usize {
            match self {
                Self::Mode1 | Self::Mode2Form1 => 2048,
                Self::Mode2 | Self::Mode2FormMix => 2336,
                Self::Mode2Form2 => 2324,
                Self::Mode1Raw | Self::Mode2Raw | Self::Audio => 2352,
            }
        }

        fn gdi_track_descriptor(self) -> Result<(u32, u32)> {
            match self {
                Self::Mode1Raw => Ok((4, 2352)),
                Self::Mode1 => Ok((4, 2048)),
                Self::Audio => Ok((0, 2352)),
                other => Err(RomWeaverError::Validation(format!(
                    "gd-rom output does not support {} tracks",
                    other.metadata_label()
                ))),
            }
        }

        fn swap_audio_bytes(self, buffer: &mut [u8]) {
            if !matches!(self, Self::Audio) {
                return;
            }
            for pair in buffer.chunks_exact_mut(2) {
                pair.swap(0, 1);
            }
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum ChdCreateKind {
        Raw,
        HardDisk(HdGeometry),
        Dvd,
        Disc(DiscLayout),
        Av(AvProfile),
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum ChdCreateModeOverride {
        Cd,
        Dvd,
        Raw,
        HardDisk,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct ChdCompressionPlan {
        codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
        primary_codec: ChdCodec,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct RustCompressedHunkEntry {
        compression_type: u8,
        offset: u64,
        length: u32,
        crc16: u16,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
    struct HunkHashKey {
        crc16: u16,
        sha1: [u8; 20],
    }

    struct ParentReuseIndex {
        by_hash: BTreeMap<HunkHashKey, u64>,
        sha1: [u8; 20],
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct RustMetadataEntry {
        tag: u32,
        flags: u8,
        data: Vec<u8>,
    }

    #[derive(Default)]
    struct MsbBitWriter {
        bytes: Vec<u8>,
        bit_len: usize,
    }

    impl MsbBitWriter {
        fn new() -> Self {
            Self::default()
        }

        fn write_bits(&mut self, value: u64, bit_count: u8) {
            if bit_count == 0 {
                return;
            }
            for shift in (0..bit_count).rev() {
                let bit = ((value >> shift) & 1) as u8;
                let byte_index = self.bit_len / 8;
                if byte_index == self.bytes.len() {
                    self.bytes.push(0);
                }
                let bit_index = 7 - (self.bit_len % 8);
                self.bytes[byte_index] |= bit << bit_index;
                self.bit_len += 1;
            }
        }

        fn align_to_byte(&mut self) {
            let remainder = self.bit_len % 8;
            if remainder == 0 {
                return;
            }
            self.write_bits(0, (8 - remainder) as u8);
        }

        fn finish(self) -> Vec<u8> {
            self.bytes
        }
    }

    const CDROM_OLD_METADATA_TAG: u32 = make_tag(b'C', b'H', b'C', b'D');
    const CDROM_TRACK_METADATA_TAG: u32 = make_tag(b'C', b'H', b'T', b'R');
    const GDROM_OLD_METADATA_TAG: u32 = make_tag(b'C', b'H', b'G', b'T');
    const AV_METADATA_TAG: u32 = make_tag(b'A', b'V', b'A', b'V');
    const AV_LD_METADATA_TAG: u32 = make_tag(b'A', b'V', b'L', b'D');

    enum ChdReadBackend {
        Rust {
            metadata_by_tag_and_index: BTreeMap<(u32, u32), Vec<u8>>,
        },
    }

    struct ChdReadSession {
        source: PathBuf,
        parent_source: Option<PathBuf>,
        header: ChdHeader,
        media_kind: ChdMediaKind,
        backend: ChdReadBackend,
    }

    impl ChdReadSession {
        fn open(source: &Path, parent_source: Option<&Path>) -> Result<Self> {
            Self::open_rust(source, parent_source).map_err(|rust_error| {
                RomWeaverError::Validation(format!(
                    "failed to open chd `{}` with rust backend ({rust_error})",
                    source.display()
                ))
            })
        }

        fn open_rust(
            source: &Path,
            parent_source: Option<&Path>,
        ) -> std::result::Result<Self, String> {
            let mut chd = Self::open_rust_chd(source, parent_source)?;

            let header = Self::convert_header(chd.header());
            let mut metadata_by_tag_and_index = BTreeMap::new();
            let metadatas: Vec<chd::metadata::Metadata> = chd
                .metadata_refs()
                .try_into()
                .map_err(|error| format!("failed to read CHD metadata: {error}"))?;
            for metadata in metadatas {
                metadata_by_tag_and_index
                    .insert((metadata.metatag, metadata.index), metadata.value);
            }
            let media_kind = Self::detect_media_kind(&metadata_by_tag_and_index);

            Ok(Self {
                source: source.to_path_buf(),
                parent_source: parent_source.map(Path::to_path_buf),
                header,
                media_kind,
                backend: ChdReadBackend::Rust {
                    metadata_by_tag_and_index,
                },
            })
        }

        fn detect_media_kind(
            metadata_by_tag_and_index: &BTreeMap<(u32, u32), Vec<u8>>,
        ) -> ChdMediaKind {
            let has_tag = |tag: u32| {
                metadata_by_tag_and_index
                    .keys()
                    .any(|(candidate, _)| *candidate == tag)
            };
            if has_tag(GDROM_TRACK_METADATA_TAG) || has_tag(GDROM_OLD_METADATA_TAG) {
                return ChdMediaKind::GdRom;
            }
            if has_tag(CDROM_TRACK_METADATA2_TAG)
                || has_tag(CDROM_TRACK_METADATA_TAG)
                || has_tag(CDROM_OLD_METADATA_TAG)
            {
                return ChdMediaKind::CdRom;
            }
            if has_tag(HARD_DISK_METADATA_TAG) {
                return ChdMediaKind::HardDisk;
            }
            if has_tag(DVD_METADATA_TAG) {
                return ChdMediaKind::Dvd;
            }
            if has_tag(AV_METADATA_TAG) || has_tag(AV_LD_METADATA_TAG) {
                return ChdMediaKind::Av;
            }
            ChdMediaKind::Raw
        }

        fn codec_from_raw(raw: u32) -> ChdCodec {
            match raw {
                0 => ChdCodec::NONE,
                1 | 2 => ChdCodec::ZLIB,
                value if value == ChdCodec::ZLIB.raw() => ChdCodec::ZLIB,
                value if value == ChdCodec::ZSTD.raw() => ChdCodec::ZSTD,
                value if value == ChdCodec::LZMA.raw() => ChdCodec::LZMA,
                value if value == ChdCodec::HUFFMAN.raw() => ChdCodec::HUFFMAN,
                value if value == ChdCodec::AVHUFF.raw() => ChdCodec::AVHUFF,
                value if value == ChdCodec::FLAC.raw() => ChdCodec::FLAC,
                value if value == ChdCodec::CD_ZLIB.raw() => ChdCodec::CD_ZLIB,
                value if value == ChdCodec::CD_ZSTD.raw() => ChdCodec::CD_ZSTD,
                value if value == ChdCodec::CD_LZMA.raw() => ChdCodec::CD_LZMA,
                value if value == ChdCodec::CD_FLAC.raw() => ChdCodec::CD_FLAC,
                _ => ChdCodec::NONE,
            }
        }

        fn convert_header(header: &chd::header::Header) -> ChdHeader {
            let compression = match header {
                chd::header::Header::V1Header(value) | chd::header::Header::V2Header(value) => {
                    [value.compression, 0, 0, 0]
                }
                chd::header::Header::V3Header(value) => [value.compression, 0, 0, 0],
                chd::header::Header::V4Header(value) => [value.compression, 0, 0, 0],
                chd::header::Header::V5Header(value) => value.compression,
            };
            ChdHeader {
                version: header.version() as u32,
                logical_bytes: header.logical_bytes(),
                hunk_bytes: header.hunk_size(),
                hunk_count: header.hunk_count(),
                unit_bytes: header.unit_bytes(),
                unit_count: header.unit_count(),
                compressed: header.is_compressed(),
                compression: compression.map(Self::codec_from_raw),
            }
        }

        fn header(&self) -> ChdHeader {
            self.header
        }

        fn media_kind(&self) -> ChdMediaKind {
            self.media_kind
        }

        fn read_metadata(&self, tag: u32, index: u32) -> Result<Option<Vec<u8>>> {
            match &self.backend {
                ChdReadBackend::Rust {
                    metadata_by_tag_and_index,
                } => Ok(metadata_by_tag_and_index.get(&(tag, index)).cloned()),
            }
        }

        fn open_rust_chd(
            source: &Path,
            parent_source: Option<&Path>,
        ) -> std::result::Result<chd::Chd<BufReader<File>>, String> {
            let parent = if let Some(parent_source) = parent_source {
                let parent_file = File::open(parent_source).map_err(|error| {
                    format!(
                        "failed to open parent chd `{}`: {error}",
                        parent_source.display()
                    )
                })?;
                let parent_reader = BufReader::new(parent_file);
                let parent_chd = chd::Chd::open(parent_reader, None).map_err(|error| {
                    format!(
                        "failed to parse parent chd `{}`: {error}",
                        parent_source.display()
                    )
                })?;
                Some(Box::new(parent_chd))
            } else {
                None
            };

            let file = File::open(source)
                .map_err(|error| format!("failed to open `{}`: {error}", source.display()))?;
            let reader = BufReader::new(file);
            chd::Chd::open(reader, parent)
                .map_err(|error| format!("failed to parse `{}`: {error}", source.display()))
        }

        fn extract_to_file(&self, output_path: &Path, thread_count: usize) -> Result<ChdHeader> {
            match &self.backend {
                ChdReadBackend::Rust { .. } => Self::extract_to_file_with_rust(
                    &self.source,
                    self.parent_source.as_deref(),
                    self.header.logical_bytes,
                    output_path,
                    thread_count,
                )
                .map_err(RomWeaverError::Validation)
                .map(|_| self.header),
            }
        }

        fn extract_to_file_with_rust(
            source: &Path,
            parent_source: Option<&Path>,
            logical_bytes: u64,
            output_path: &Path,
            thread_count: usize,
        ) -> std::result::Result<(), String> {
            #[cfg(any(unix, windows))]
            if thread_count > 1 {
                return Self::extract_to_file_with_rust_parallel(
                    source,
                    parent_source,
                    logical_bytes,
                    output_path,
                    thread_count,
                );
            }

            let mut chd = Self::open_rust_chd(source, parent_source)
                .map_err(|error| format!("failed to decode `{}`: {error}", source.display()))?;

            let mut output = File::create(output_path).map_err(|error| {
                format!("failed to create `{}`: {error}", output_path.display())
            })?;
            let mut remaining = logical_bytes;
            let mut hunk_buffer = chd.get_hunksized_buffer();
            let mut compressed_buffer = Vec::new();
            for hunk_index in 0..chd.header().hunk_count() {
                if remaining == 0 {
                    break;
                }
                let mut hunk = chd.hunk(hunk_index).map_err(|error| {
                    format!(
                        "failed to decode hunk {} of `{}`: {error}",
                        hunk_index,
                        source.display()
                    )
                })?;
                hunk.read_hunk_in(&mut compressed_buffer, &mut hunk_buffer)
                    .map_err(|error| {
                        format!(
                            "failed to read hunk {} of `{}`: {error}",
                            hunk_index,
                            source.display()
                        )
                    })?;
                let write_len = usize::try_from(remaining.min(hunk_buffer.len() as u64))
                    .map_err(|_| "decoded CHD chunk exceeded addressable memory".to_string())?;
                output
                    .write_all(&hunk_buffer[..write_len])
                    .map_err(|error| {
                        format!("failed to write `{}`: {error}", output_path.display())
                    })?;
                remaining -= write_len as u64;
            }

            Ok(())
        }

        #[cfg(any(unix, windows))]
        fn extract_to_file_with_rust_parallel(
            source: &Path,
            parent_source: Option<&Path>,
            logical_bytes: u64,
            output_path: &Path,
            thread_count: usize,
        ) -> std::result::Result<(), String> {
            let chd = Self::open_rust_chd(source, parent_source)
                .map_err(|error| format!("failed to decode `{}`: {error}", source.display()))?;
            let hunk_count = chd.header().hunk_count();
            let hunk_bytes = chd.header().hunk_size() as u64;
            drop(chd);

            let output = File::create(output_path).map_err(|error| {
                format!("failed to create `{}`: {error}", output_path.display())
            })?;
            output.set_len(logical_bytes).map_err(|error| {
                format!(
                    "failed to size `{}` to {} bytes: {error}",
                    output_path.display(),
                    logical_bytes
                )
            })?;

            let hunk_count_usize = usize::try_from(hunk_count)
                .map_err(|_| "CHD hunk count exceeded addressable memory".to_string())?;
            if hunk_count_usize == 0 {
                return Ok(());
            }
            let effective_threads = thread_count.max(1).min(hunk_count_usize);
            if effective_threads <= 1 {
                return Self::extract_to_file_with_rust(
                    source,
                    parent_source,
                    logical_bytes,
                    output_path,
                    1,
                );
            }

            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(effective_threads)
                .build()
                .map_err(|error| {
                    format!(
                        "failed to build CHD rust extraction pool (threads={}): {error}",
                        effective_threads
                    )
                })?;

            let source = source.to_path_buf();
            let parent_source = parent_source.map(Path::to_path_buf);
            let output = Arc::new(output);
            let hunk_indices: Vec<u32> = (0..hunk_count).collect();
            let chunk_size = hunk_indices.len().div_ceil(effective_threads).max(1);

            let chunk_results = pool.install(|| {
                hunk_indices
                    .par_chunks(chunk_size)
                    .map(|chunk| {
                        let mut chd = Self::open_rust_chd(&source, parent_source.as_deref())
                            .map_err(|error| {
                                format!("failed to decode `{}`: {error}", source.display())
                            })?;

                        let mut hunk_buffer = chd.get_hunksized_buffer();
                        let mut compressed_buffer = Vec::new();

                        for &hunk_index in chunk {
                            let mut hunk = chd.hunk(hunk_index).map_err(|error| {
                                format!(
                                    "failed to decode hunk {} of `{}`: {error}",
                                    hunk_index,
                                    source.display()
                                )
                            })?;
                            hunk.read_hunk_in(&mut compressed_buffer, &mut hunk_buffer)
                                .map_err(|error| {
                                    format!(
                                        "failed to read hunk {} of `{}`: {error}",
                                        hunk_index,
                                        source.display()
                                    )
                                })?;

                            let offset = u64::from(hunk_index).saturating_mul(hunk_bytes);
                            if offset >= logical_bytes {
                                continue;
                            }
                            let write_len = usize::try_from(
                                logical_bytes
                                    .saturating_sub(offset)
                                    .min(hunk_buffer.len() as u64),
                            )
                            .map_err(|_| {
                                "decoded CHD chunk exceeded addressable memory".to_string()
                            })?;
                            Self::write_all_at(&output, &hunk_buffer[..write_len], offset)
                                .map_err(|error| {
                                    format!(
                                        "failed to write `{}` at offset {}: {error}",
                                        output_path.display(),
                                        offset
                                    )
                                })?;
                        }
                        Ok(())
                    })
                    .collect::<Vec<std::result::Result<(), String>>>()
            });

            for result in chunk_results {
                result?;
            }
            Ok(())
        }

        #[cfg(unix)]
        fn write_all_at(file: &File, mut bytes: &[u8], mut offset: u64) -> io::Result<()> {
            use std::os::unix::fs::FileExt as _;

            while !bytes.is_empty() {
                let written = file.write_at(bytes, offset)?;
                if written == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "failed to write CHD chunk",
                    ));
                }
                offset = offset.saturating_add(written as u64);
                bytes = &bytes[written..];
            }
            Ok(())
        }

        #[cfg(all(not(unix), windows))]
        fn write_all_at(file: &File, mut bytes: &[u8], mut offset: u64) -> io::Result<()> {
            use std::os::windows::fs::FileExt as _;

            while !bytes.is_empty() {
                let written = file.seek_write(bytes, offset)?;
                if written == 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "failed to write CHD chunk",
                    ));
                }
                offset = offset.saturating_add(written as u64);
                bytes = &bytes[written..];
            }
            Ok(())
        }
    }

    fn split_token(text: &str) -> Option<(&str, &str)> {
        let trimmed = text.trim_start();
        if trimmed.is_empty() {
            return None;
        }
        if let Some(rest) = trimmed.strip_prefix('"') {
            let end = rest.find('"')?;
            let token = &rest[..end];
            let remainder = &rest[end + 1..];
            Some((token, remainder))
        } else {
            let end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
            Some((&trimmed[..end], &trimmed[end..]))
        }
    }

    impl ChdContainerHandler {
        const DEFAULT_HUNK_BYTES: u32 = 4096;
        const DVD_SECTOR_BYTES: u32 = 2048;
        const HD_SECTOR_BYTES: u32 = 512;
        const CD_FRAME_BYTES: u32 = CD_FRAME_SIZE;
        const CD_HUNK_BYTES: u32 = CD_FRAME_SIZE * 8;
        const FLAC_CHANNELS: usize = 2;
        const FLAC_BITS_PER_SAMPLE: usize = 16;
        const FLAC_SAMPLE_RATE_HZ: usize = 44_100;
        const CD_SECTOR_DATA_BYTES: usize = 2352;
        const CD_SUBCODE_BYTES: usize = 96;
        const ZLIB_LEVEL_MIN: i32 = 1;
        const ZLIB_LEVEL_MAX: i32 = 9;
        const ZSTD_LEVEL_MIN: i32 = -7;
        const LZMA_LEVEL_MIN: i32 = 0;
        const LZMA_LEVEL_MAX: i32 = 9;
        const CHD_V5_HEADER_BYTES: u64 = 124;
        const CHD_V5_MAP_TYPE_COMPRESSED_MAX: u8 = 3;
        const CHD_V5_MAP_TYPE_UNCOMPRESSED: u8 = 4;
        const CHD_V5_MAP_TYPE_SELF: u8 = 5;
        const CHD_V5_MAP_TYPE_PARENT: u8 = 6;
        const CHD_V5_MAP_TYPE_MAX: u8 = 6;
        const CHD_V5_HEADER_MAP_OFFSET: u64 = 40;
        const CHD_V5_HEADER_META_OFFSET: u64 = 48;
        const CHD_V5_HEADER_RAW_SHA1_OFFSET: u64 = 64;
        const CHD_V5_HEADER_SHA1_OFFSET: u64 = 84;
        const CHD_V5_HEADER_PARENT_SHA1_OFFSET: u64 = 104;
        const CHD_SHA1_BYTES: usize = 20;
        const HUFFMAN_SMALL_TREE_BITS: [u8; 5] = [1, 7, 0, 1, 7];
        const AVHUFF_DELTA_TREE_SYMBOLS: usize = 256 + 16;
        const AVHUFF_DELTA_TREE_BITS: u8 = 5;
        const AVHUFF_DELTA_TREE_8BIT_COUNT: usize = 240;

        fn supports_rust_create(
            &self,
            create_kind: &ChdCreateKind,
            codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
            primary_codec: ChdCodec,
        ) -> bool {
            let mut active_codecs = Vec::new();
            let mut saw_none = false;
            for codec in codecs {
                if codec == ChdCodec::NONE {
                    saw_none = true;
                    continue;
                }
                if saw_none {
                    // Codec slots must be contiguous.
                    return false;
                }
                active_codecs.push(codec);
            }
            if primary_codec == ChdCodec::NONE {
                return active_codecs.is_empty() && !matches!(create_kind, ChdCreateKind::Av(_));
            }
            if active_codecs.is_empty() || active_codecs[0] != primary_codec {
                return false;
            }
            active_codecs
                .into_iter()
                .all(|codec| self.supports_create_codec(create_kind, codec))
        }

        fn supports_create_codec(&self, create_kind: &ChdCreateKind, codec: ChdCodec) -> bool {
            match create_kind {
                ChdCreateKind::Raw | ChdCreateKind::Dvd | ChdCreateKind::HardDisk(_) => {
                    matches!(
                        codec,
                        ChdCodec::NONE
                            | ChdCodec::ZSTD
                            | ChdCodec::ZLIB
                            | ChdCodec::LZMA
                            | ChdCodec::HUFFMAN
                            | ChdCodec::FLAC
                    )
                }
                ChdCreateKind::Disc(_) => {
                    matches!(
                        codec,
                        ChdCodec::NONE
                            | ChdCodec::CD_ZSTD
                            | ChdCodec::CD_ZLIB
                            | ChdCodec::CD_LZMA
                            | ChdCodec::CD_FLAC
                    )
                }
                ChdCreateKind::Av(_) => matches!(codec, ChdCodec::NONE | ChdCodec::AVHUFF),
            }
        }

        fn supports_rust_encode_codec(&self, create_kind: &ChdCreateKind, codec: ChdCodec) -> bool {
            match create_kind {
                ChdCreateKind::Raw | ChdCreateKind::Dvd | ChdCreateKind::HardDisk(_) => {
                    matches!(
                        codec,
                        ChdCodec::ZSTD
                            | ChdCodec::ZLIB
                            | ChdCodec::LZMA
                            | ChdCodec::HUFFMAN
                            | ChdCodec::FLAC
                    )
                }
                ChdCreateKind::Disc(_) => {
                    matches!(
                        codec,
                        ChdCodec::CD_ZSTD
                            | ChdCodec::CD_ZLIB
                            | ChdCodec::CD_LZMA
                            | ChdCodec::CD_FLAC
                    )
                }
                ChdCreateKind::Av(_) => matches!(codec, ChdCodec::AVHUFF),
            }
        }

        fn should_attempt_rust_create(
            &self,
            create_kind: &ChdCreateKind,
            codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
            primary_codec: ChdCodec,
        ) -> bool {
            self.supports_rust_create(create_kind, codecs, primary_codec)
        }

        fn media_kind_from_create_kind(&self, create_kind: &ChdCreateKind) -> ChdMediaKind {
            match create_kind {
                ChdCreateKind::Raw => ChdMediaKind::Raw,
                ChdCreateKind::HardDisk(_) => ChdMediaKind::HardDisk,
                ChdCreateKind::Dvd => ChdMediaKind::Dvd,
                ChdCreateKind::Disc(layout) => match layout.kind {
                    DiscKind::CdRom => ChdMediaKind::CdRom,
                    DiscKind::GdRom => ChdMediaKind::GdRom,
                },
                ChdCreateKind::Av(_) => ChdMediaKind::Av,
            }
        }

        fn media_label(&self, media_kind: ChdMediaKind) -> &'static str {
            match media_kind {
                ChdMediaKind::Raw => "raw",
                ChdMediaKind::HardDisk => "hd",
                ChdMediaKind::CdRom => "cd",
                ChdMediaKind::GdRom => "gd",
                ChdMediaKind::Dvd => "dvd",
                ChdMediaKind::Av => "av",
            }
        }

        fn resolve_compression_plan(
            &self,
            codec: Option<&str>,
            create_kind: &ChdCreateKind,
        ) -> Result<ChdCompressionPlan> {
            if let Some(codecs) = self.parse_explicit_codecs(codec)? {
                return self.explicit_codec_plan(codecs);
            }
            Ok(self.default_compression_plan(create_kind))
        }

        fn normalize_compression_plan_for_create_kind(
            &self,
            create_kind: &ChdCreateKind,
            mut plan: ChdCompressionPlan,
        ) -> ChdCompressionPlan {
            if matches!(create_kind, ChdCreateKind::Disc(_)) {
                let map_disc_codec = |codec: ChdCodec| match codec {
                    ChdCodec::ZSTD => ChdCodec::CD_ZSTD,
                    ChdCodec::ZLIB => ChdCodec::CD_ZLIB,
                    ChdCodec::LZMA => ChdCodec::CD_LZMA,
                    ChdCodec::FLAC => ChdCodec::CD_FLAC,
                    other => other,
                };
                plan.codecs = plan.codecs.map(map_disc_codec);
                plan.primary_codec = map_disc_codec(plan.primary_codec);
            }

            plan
        }

        #[cfg(test)]
        pub(super) fn default_cd_compression_plan_for_tests(
            &self,
        ) -> Result<([ChdCodec; CHD_MAX_COMPRESSORS], ChdCodec)> {
            let create_kind = ChdCreateKind::Disc(DiscLayout {
                kind: DiscKind::CdRom,
                tracks: Vec::new(),
            });
            let plan = self.resolve_compression_plan(None, &create_kind)?;
            Ok((plan.codecs, plan.primary_codec))
        }

        #[cfg(test)]
        pub(super) fn default_dvd_compression_plan_for_tests(
            &self,
        ) -> Result<([ChdCodec; CHD_MAX_COMPRESSORS], ChdCodec)> {
            let plan = self.resolve_compression_plan(None, &ChdCreateKind::Dvd)?;
            Ok((plan.codecs, plan.primary_codec))
        }

        #[cfg(test)]
        pub(super) fn default_raw_compression_plan_for_tests(
            &self,
        ) -> Result<([ChdCodec; CHD_MAX_COMPRESSORS], ChdCodec)> {
            let plan = self.resolve_compression_plan(None, &ChdCreateKind::Raw)?;
            Ok((plan.codecs, plan.primary_codec))
        }

        #[cfg(test)]
        pub(super) fn explicit_compression_plan_for_tests(
            &self,
            codecs: &str,
        ) -> Result<([ChdCodec; CHD_MAX_COMPRESSORS], ChdCodec)> {
            let plan = self.resolve_compression_plan(Some(codecs), &ChdCreateKind::Raw)?;
            Ok((plan.codecs, plan.primary_codec))
        }

        #[cfg(test)]
        pub(super) fn rust_backend_can_create_with_codec_list_for_tests(
            &self,
            codecs: &str,
        ) -> Result<bool> {
            let plan = self.resolve_compression_plan(Some(codecs), &ChdCreateKind::Raw)?;
            Ok(self.should_attempt_rust_create(
                &ChdCreateKind::Raw,
                plan.codecs,
                plan.primary_codec,
            ))
        }

        #[cfg(test)]
        pub(super) fn create_raw_store_with_rust_backend_for_tests(
            &self,
            source: &Path,
            output: &Path,
        ) -> Result<ChdHeader> {
            let logical_bytes = fs::metadata(source)?.len();
            self.create_uncompressed_rust_raw(source, output, logical_bytes, &ChdCreateKind::Raw)
        }

        #[cfg(test)]
        pub(super) fn create_raw_with_rust_backend_codec_for_tests(
            &self,
            source: &Path,
            output: &Path,
            codec: ChdCodec,
            level: i32,
            thread_count: usize,
        ) -> Result<ChdHeader> {
            let logical_bytes = fs::metadata(source)?.len();
            if codec == ChdCodec::NONE {
                self.create_uncompressed_rust_raw(
                    source,
                    output,
                    logical_bytes,
                    &ChdCreateKind::Raw,
                )
            } else {
                self.create_compressed_rust_raw(
                    source,
                    output,
                    logical_bytes,
                    &ChdCreateKind::Raw,
                    [codec, ChdCodec::NONE, ChdCodec::NONE, ChdCodec::NONE],
                    level,
                    thread_count,
                    None,
                )
            }
        }

        #[cfg(test)]
        pub(super) fn extract_raw_with_rust_backend_for_tests(
            &self,
            source: &Path,
            output: &Path,
            thread_count: usize,
        ) -> Result<()> {
            let session =
                ChdReadSession::open_rust(source, None).map_err(RomWeaverError::Validation)?;
            let media_kind = session.media_kind();
            if matches!(media_kind, ChdMediaKind::CdRom | ChdMediaKind::GdRom) {
                return Err(RomWeaverError::Validation(
                    "rust backend raw extract helper only supports non-disc media".to_string(),
                ));
            }
            session.extract_to_file(output, thread_count).map(|_| ())
        }

        #[cfg(test)]
        pub(super) fn encode_raw_flac_payload_for_tests(&self, hunk: &[u8]) -> Result<Vec<u8>> {
            self.compress_rust_hunk(&ChdCreateKind::Raw, ChdCodec::FLAC, 0, hunk)
        }

        #[cfg(test)]
        pub(super) fn encode_cd_flac_payload_for_tests(&self, hunk: &[u8]) -> Result<Vec<u8>> {
            self.compress_rust_cd_hunk(ChdCodec::CD_FLAC, 0, hunk)
        }

        fn explicit_codec_plan(&self, codecs: Vec<ChdCodec>) -> Result<ChdCompressionPlan> {
            if codecs.is_empty() {
                return Err(RomWeaverError::Validation(
                    "chd codec list cannot be empty".to_string(),
                ));
            }
            if codecs.len() > CHD_MAX_COMPRESSORS {
                return Err(RomWeaverError::Validation(format!(
                    "chd supports at most {CHD_MAX_COMPRESSORS} codecs; received {}",
                    codecs.len()
                )));
            }
            if codecs[0] == ChdCodec::NONE && codecs.len() > 1 {
                return Err(RomWeaverError::Validation(
                    "chd codec `store` cannot be combined with additional codecs".to_string(),
                ));
            }
            if codecs
                .iter()
                .enumerate()
                .skip(1)
                .any(|(_, codec)| *codec == ChdCodec::AVHUFF)
            {
                return Err(RomWeaverError::Validation(
                    "chd codec `avhuff` must be the first codec when multiple codecs are provided"
                        .to_string(),
                ));
            }
            let primary_codec = codecs[0];
            let mut resolved_codecs = [ChdCodec::NONE; CHD_MAX_COMPRESSORS];
            for (index, codec) in codecs.into_iter().enumerate() {
                resolved_codecs[index] = codec;
            }
            Ok(ChdCompressionPlan {
                codecs: resolved_codecs,
                primary_codec,
            })
        }

        fn default_compression_plan(&self, create_kind: &ChdCreateKind) -> ChdCompressionPlan {
            match create_kind {
                ChdCreateKind::Disc(layout) => match layout.kind {
                    DiscKind::CdRom | DiscKind::GdRom => ChdCompressionPlan {
                        codecs: [
                            ChdCodec::CD_ZSTD,
                            ChdCodec::CD_ZLIB,
                            ChdCodec::CD_FLAC,
                            ChdCodec::NONE,
                        ],
                        primary_codec: ChdCodec::CD_ZSTD,
                    },
                },
                ChdCreateKind::Dvd => ChdCompressionPlan {
                    codecs: [
                        ChdCodec::ZSTD,
                        ChdCodec::ZLIB,
                        ChdCodec::HUFFMAN,
                        ChdCodec::FLAC,
                    ],
                    primary_codec: ChdCodec::ZSTD,
                },
                _ => ChdCompressionPlan {
                    codecs: [
                        ChdCodec::ZSTD,
                        ChdCodec::ZLIB,
                        ChdCodec::HUFFMAN,
                        ChdCodec::FLAC,
                    ],
                    primary_codec: ChdCodec::ZSTD,
                },
            }
        }

        fn parse_explicit_codecs(&self, codec: Option<&str>) -> Result<Option<Vec<ChdCodec>>> {
            let Some(codec) = codec else {
                return Ok(None);
            };
            let codec = codec.trim();
            if codec.is_empty() {
                return Ok(None);
            }

            let mut codecs = Vec::new();
            for entry in codec.split([',', '+']) {
                let entry = entry.trim();
                if entry.is_empty() {
                    return Err(RomWeaverError::Validation(
                        "chd codec list contains an empty entry".to_string(),
                    ));
                }
                codecs.push(self.map_codec(entry)?);
            }
            Ok(Some(codecs))
        }

        fn map_codec(&self, codec: &str) -> Result<ChdCodec> {
            let normalized = codec.trim().to_ascii_lowercase();
            match normalized.as_str() {
                "huff" | "huffman" => return Ok(ChdCodec::HUFFMAN),
                "flac" => return Ok(ChdCodec::FLAC),
                "cdzl" => return Ok(ChdCodec::CD_ZLIB),
                "cdzs" => return Ok(ChdCodec::CD_ZSTD),
                "cdlz" => return Ok(ChdCodec::CD_LZMA),
                "cdfl" => return Ok(ChdCodec::CD_FLAC),
                "avhu" | "avhuff" => return Ok(ChdCodec::AVHUFF),
                _ => {}
            }

            match parse_requested_codec(Some(codec)) {
                RequestedCodec::Unspecified => Ok(ChdCodec::ZSTD),
                RequestedCodec::Known(CanonicalCodec::Store) => Ok(ChdCodec::NONE),
                RequestedCodec::Known(CanonicalCodec::Deflate) => Ok(ChdCodec::ZLIB),
                RequestedCodec::Known(CanonicalCodec::Zstd) => Ok(ChdCodec::ZSTD),
                RequestedCodec::Known(CanonicalCodec::Lzma)
                | RequestedCodec::Known(CanonicalCodec::Lzma2) => Ok(ChdCodec::LZMA),
                RequestedCodec::Known(CanonicalCodec::Huffman) => Ok(ChdCodec::HUFFMAN),
                RequestedCodec::Known(codec) => Err(RomWeaverError::Validation(format!(
                    "unsupported chd codec `{}`; supported codecs are store, zlib, zstd, lzma, huff (alias: huffman), flac, cdlz, cdzl, cdzs, cdfl, and avhuff (alias: avhu)",
                    codec.name()
                ))),
                RequestedCodec::Unknown(name) => Err(RomWeaverError::Validation(format!(
                    "unsupported chd codec `{name}`; supported codecs are store, zlib, zstd, lzma, huff (alias: huffman), flac, cdlz, cdzl, cdzs, cdfl, and avhuff (alias: avhu)"
                ))),
            }
        }

        fn resolve_compression_level(&self, codec: ChdCodec, level: Option<i32>) -> Result<i32> {
            let Some(level) = level else {
                return Ok(0);
            };

            let codec_label = self.codec_label(codec);
            let zstd_max_level = zstd::zstd_safe::max_c_level() as i32;
            let range = match codec {
                ChdCodec::ZLIB | ChdCodec::CD_ZLIB => {
                    Some((Self::ZLIB_LEVEL_MIN, Self::ZLIB_LEVEL_MAX))
                }
                ChdCodec::ZSTD | ChdCodec::CD_ZSTD => Some((Self::ZSTD_LEVEL_MIN, zstd_max_level)),
                ChdCodec::LZMA | ChdCodec::CD_LZMA => {
                    Some((Self::LZMA_LEVEL_MIN, Self::LZMA_LEVEL_MAX))
                }
                ChdCodec::NONE
                | ChdCodec::HUFFMAN
                | ChdCodec::FLAC
                | ChdCodec::CD_FLAC
                | ChdCodec::AVHUFF => None,
                _ => None,
            };

            let Some((min, max)) = range else {
                return Err(RomWeaverError::Validation(format!(
                    "chd codec `{codec_label}` does not accept --level"
                )));
            };
            if (min..=max).contains(&level) {
                Ok(level)
            } else {
                Err(RomWeaverError::Validation(format!(
                    "chd codec `{codec_label}` level `{level}` is out of range; expected {min}..={max}"
                )))
            }
        }

        fn codec_label(&self, codec: ChdCodec) -> &'static str {
            match codec {
                ChdCodec::NONE => "store",
                ChdCodec::ZLIB => "zlib",
                ChdCodec::ZSTD => "zstd",
                ChdCodec::LZMA => "lzma",
                ChdCodec::HUFFMAN => "huff",
                ChdCodec::AVHUFF => "avhuff",
                ChdCodec::FLAC => "flac",
                ChdCodec::CD_ZLIB => "cdzl",
                ChdCodec::CD_ZSTD => "cdzs",
                ChdCodec::CD_LZMA => "cdlz",
                ChdCodec::CD_FLAC => "cdfl",
                _ => "unknown",
            }
        }

        fn header_codec_label(&self, header: ChdHeader) -> String {
            let codecs = header
                .compression
                .into_iter()
                .filter(|codec| *codec != ChdCodec::NONE)
                .map(|codec| self.codec_label(codec).to_string())
                .collect::<Vec<_>>();
            if codecs.is_empty() {
                "store".to_string()
            } else {
                codecs.join("+")
            }
        }

        fn extract_extension(&self, media_kind: ChdMediaKind) -> Result<&'static str> {
            match media_kind {
                ChdMediaKind::Raw => Ok(".bin"),
                ChdMediaKind::HardDisk => Ok(".img"),
                ChdMediaKind::Dvd => Ok(".iso"),
                ChdMediaKind::CdRom => Ok(".cue"),
                ChdMediaKind::GdRom => Ok(".gdi"),
                ChdMediaKind::Av => Ok(".avi"),
            }
        }

        fn extract_name(&self, source: &Path, media_kind: ChdMediaKind) -> Result<String> {
            let stem = source
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("output");
            Ok(format!("{stem}{}", self.extract_extension(media_kind)?))
        }

        fn parse_disc_mode(&self, value: &str) -> Result<DiscTrackMode> {
            match value.trim().to_ascii_uppercase().as_str() {
                "MODE1" | "MODE1/2048" => Ok(DiscTrackMode::Mode1),
                "MODE1/2352" | "MODE1_RAW" => Ok(DiscTrackMode::Mode1Raw),
                "MODE2" | "MODE2/2336" => Ok(DiscTrackMode::Mode2),
                "MODE2_FORM1" | "MODE2/2048" => Ok(DiscTrackMode::Mode2Form1),
                "MODE2_FORM2" | "MODE2/2324" => Ok(DiscTrackMode::Mode2Form2),
                "MODE2_FORM_MIX" => Ok(DiscTrackMode::Mode2FormMix),
                "MODE2/2352" | "MODE2_RAW" | "CDI/2352" => Ok(DiscTrackMode::Mode2Raw),
                "AUDIO" => Ok(DiscTrackMode::Audio),
                other => Err(RomWeaverError::Validation(format!(
                    "unsupported disc track type `{other}`; supported types are MODE1/2048, MODE1/2352, MODE2/2336, MODE2/2048, MODE2/2324, MODE2_FORM_MIX, MODE2/2352, and AUDIO"
                ))),
            }
        }

        fn parse_msf(&self, value: &str) -> Result<u32> {
            let mut parts = value.split(':');
            let minutes = parts
                .next()
                .ok_or_else(|| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?
                .parse::<u32>()
                .map_err(|_| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?;
            let seconds = parts
                .next()
                .ok_or_else(|| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?
                .parse::<u32>()
                .map_err(|_| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?;
            let frames = parts
                .next()
                .ok_or_else(|| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?
                .parse::<u32>()
                .map_err(|_| RomWeaverError::Validation(format!("invalid cue time `{value}`")))?;
            if parts.next().is_some() || seconds >= 60 || frames >= 75 {
                return Err(RomWeaverError::Validation(format!(
                    "invalid cue time `{value}`"
                )));
            }
            Ok(minutes * 60 * 75 + seconds * 75 + frames)
        }

        fn format_msf(&self, frames: u32) -> String {
            let minutes = frames / (60 * 75);
            let seconds = (frames / 75) % 60;
            let frame = frames % 75;
            format!("{minutes:02}:{seconds:02}:{frame:02}")
        }

        fn parse_wave_file(&self, path: &Path) -> Result<(u64, u64)> {
            let mut reader = BufReader::new(File::open(path)?);
            let mut header = [0_u8; 12];
            reader.read_exact(&mut header)?;
            if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
                return Err(RomWeaverError::Validation(format!(
                    "wave track `{}` is not a RIFF/WAVE file",
                    path.display()
                )));
            }

            let mut audio_format = None;
            let mut channels = None;
            let mut sample_rate = None;
            let mut block_align = None;
            let mut bits_per_sample = None;
            let mut data = None;

            loop {
                let mut chunk_header = [0_u8; 8];
                match reader.read_exact(&mut chunk_header) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(error) => return Err(error.into()),
                }

                let chunk_size = u64::from(u32::from_le_bytes([
                    chunk_header[4],
                    chunk_header[5],
                    chunk_header[6],
                    chunk_header[7],
                ]));
                let chunk_data_offset = reader.stream_position()?;
                let padded_size = chunk_size + (chunk_size % 2);

                match &chunk_header[..4] {
                    b"fmt " => {
                        let chunk_len = usize::try_from(chunk_size).map_err(|_| {
                            RomWeaverError::Validation(format!(
                                "wave track `{}` has an oversized fmt chunk",
                                path.display()
                            ))
                        })?;
                        let mut chunk = vec![0_u8; chunk_len];
                        reader.read_exact(&mut chunk)?;
                        if chunk.len() < 16 {
                            return Err(RomWeaverError::Validation(format!(
                                "wave track `{}` has a truncated fmt chunk",
                                path.display()
                            )));
                        }
                        audio_format = Some(u16::from_le_bytes([chunk[0], chunk[1]]));
                        channels = Some(u16::from_le_bytes([chunk[2], chunk[3]]));
                        sample_rate =
                            Some(u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]));
                        block_align = Some(u16::from_le_bytes([chunk[12], chunk[13]]));
                        bits_per_sample = Some(u16::from_le_bytes([chunk[14], chunk[15]]));
                        if padded_size != chunk_size {
                            reader.seek(SeekFrom::Current(1))?;
                        }
                    }
                    b"data" => {
                        data = Some((chunk_data_offset, chunk_size));
                        let skip = i64::try_from(padded_size).map_err(|_| {
                            RomWeaverError::Validation(format!(
                                "wave track `{}` is too large for current parsing support",
                                path.display()
                            ))
                        })?;
                        reader.seek(SeekFrom::Current(skip))?;
                    }
                    _ => {
                        let skip = i64::try_from(padded_size).map_err(|_| {
                            RomWeaverError::Validation(format!(
                                "wave track `{}` is too large for current parsing support",
                                path.display()
                            ))
                        })?;
                        reader.seek(SeekFrom::Current(skip))?;
                    }
                }
            }

            let audio_format = audio_format.ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "wave track `{}` is missing a fmt chunk",
                    path.display()
                ))
            })?;
            if audio_format != 1 {
                return Err(RomWeaverError::Validation(format!(
                    "wave track `{}` uses unsupported format code {}; only PCM WAVE tracks are supported",
                    path.display(),
                    audio_format
                )));
            }
            if channels != Some(2)
                || sample_rate != Some(44_100)
                || block_align != Some(4)
                || bits_per_sample != Some(16)
            {
                return Err(RomWeaverError::Validation(format!(
                    "wave track `{}` must be 44.1 kHz 16-bit stereo PCM for chd audio tracks",
                    path.display()
                )));
            }

            let (data_offset, data_len) = data.ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "wave track `{}` is missing a data chunk",
                    path.display()
                ))
            })?;
            if data_len % 2352 != 0 {
                return Err(RomWeaverError::Validation(format!(
                    "wave track `{}` data length is not divisible by 2352 bytes",
                    path.display()
                )));
            }
            Ok((data_offset, data_len))
        }

        fn parse_cue_file(&self, path: &Path) -> Result<DiscLayout> {
            #[derive(Clone, Debug)]
            struct PendingTrack {
                number: u32,
                mode: DiscTrackMode,
                file_path: PathBuf,
                file_offset_base_bytes: u64,
                file_data_len_bytes: u64,
                index00_frames: Option<u32>,
                index01_frames: Option<u32>,
                pregap_frames: u32,
                postgap_frames: u32,
                swap_audio_on_read: bool,
            }

            #[derive(Clone, Debug)]
            struct PendingFile {
                path: PathBuf,
                data_offset_bytes: u64,
                data_len_bytes: u64,
                swap_audio_on_read: bool,
            }

            let cue_dir = path.parent().unwrap_or_else(|| Path::new("."));
            let text = fs::read_to_string(path)?;
            let mut tracks = Vec::<PendingTrack>::new();
            let mut current_file: Option<PendingFile> = None;
            let mut current_track: Option<usize> = None;

            for raw_line in text.lines() {
                let line = raw_line.trim();
                if line.is_empty() {
                    continue;
                }
                let keyword_end = line.find(char::is_whitespace).unwrap_or(line.len());
                let keyword = line[..keyword_end].to_ascii_uppercase();
                let remainder = line[keyword_end..].trim_start();
                match keyword.as_str() {
                    "REM" | "TITLE" | "PERFORMER" | "SONGWRITER" | "FLAGS" | "CATALOG" | "ISRC" => {
                    }
                    "FILE" => {
                        let (name, rest) = split_token(remainder).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "invalid FILE entry in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let (kind, _) = split_token(rest).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "missing FILE type in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let full_path = cue_dir.join(name);
                        let kind = kind.trim().to_ascii_uppercase();
                        current_file = Some(match kind.as_str() {
                            "BINARY" => PendingFile {
                                path: full_path.clone(),
                                data_offset_bytes: 0,
                                data_len_bytes: fs::metadata(&full_path)?.len(),
                                swap_audio_on_read: true,
                            },
                            "MOTOROLA" => PendingFile {
                                path: full_path.clone(),
                                data_offset_bytes: 0,
                                data_len_bytes: fs::metadata(&full_path)?.len(),
                                swap_audio_on_read: false,
                            },
                            "WAVE" => {
                                let (data_offset_bytes, data_len_bytes) =
                                    self.parse_wave_file(&full_path)?;
                                PendingFile {
                                    path: full_path,
                                    data_offset_bytes,
                                    data_len_bytes,
                                    swap_audio_on_read: true,
                                }
                            }
                            other => {
                                return Err(RomWeaverError::Validation(format!(
                                    "cue `{}` uses FILE type `{other}`; current chd cue support accepts BINARY, MOTOROLA, and WAVE files",
                                    path.display()
                                )));
                            }
                        });
                        current_track = None;
                    }
                    "TRACK" => {
                        let Some(file) = current_file.clone() else {
                            return Err(RomWeaverError::Validation(format!(
                                "TRACK entry appeared before FILE in cue `{}`",
                                path.display()
                            )));
                        };
                        let (number, rest) = split_token(remainder).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "invalid TRACK entry in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let (mode, _) = split_token(rest).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "missing TRACK type in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let number = number.parse::<u32>().map_err(|_| {
                            RomWeaverError::Validation(format!(
                                "invalid TRACK number `{number}` in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let mode = self.parse_disc_mode(mode)?;
                        if file.data_offset_bytes != 0 && mode != DiscTrackMode::Audio {
                            return Err(RomWeaverError::Validation(format!(
                                "cue `{}` uses a WAVE file for non-audio track {}",
                                path.display(),
                                number
                            )));
                        }
                        tracks.push(PendingTrack {
                            number,
                            mode,
                            file_path: file.path.clone(),
                            file_offset_base_bytes: file.data_offset_bytes,
                            file_data_len_bytes: file.data_len_bytes,
                            index00_frames: None,
                            index01_frames: None,
                            pregap_frames: 0,
                            postgap_frames: 0,
                            swap_audio_on_read: file.swap_audio_on_read,
                        });
                        current_track = Some(tracks.len() - 1);
                    }
                    "INDEX" => {
                        let Some(track_index) = current_track else {
                            return Err(RomWeaverError::Validation(format!(
                                "INDEX entry appeared before TRACK in cue `{}`",
                                path.display()
                            )));
                        };
                        let (index_number, rest) = split_token(remainder).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "invalid INDEX entry in cue `{}`",
                                path.display()
                            ))
                        })?;
                        let (time, _) = split_token(rest).ok_or_else(|| {
                            RomWeaverError::Validation(format!(
                                "missing INDEX time in cue `{}`",
                                path.display()
                            ))
                        })?;
                        match index_number {
                            "00" => {
                                tracks[track_index].index00_frames = Some(self.parse_msf(time)?)
                            }
                            "01" => {
                                tracks[track_index].index01_frames = Some(self.parse_msf(time)?)
                            }
                            other => {
                                return Err(RomWeaverError::Validation(format!(
                                    "cue `{}` uses unsupported index `{other}`; current chd cue support accepts INDEX 00 and INDEX 01",
                                    path.display()
                                )));
                            }
                        }
                    }
                    "PREGAP" => {
                        let Some(track_index) = current_track else {
                            return Err(RomWeaverError::Validation(format!(
                                "PREGAP entry appeared before TRACK in cue `{}`",
                                path.display()
                            )));
                        };
                        tracks[track_index].pregap_frames = self.parse_msf(remainder)?;
                    }
                    "POSTGAP" => {
                        let Some(track_index) = current_track else {
                            return Err(RomWeaverError::Validation(format!(
                                "POSTGAP entry appeared before TRACK in cue `{}`",
                                path.display()
                            )));
                        };
                        tracks[track_index].postgap_frames = self.parse_msf(remainder)?;
                    }
                    other => {
                        return Err(RomWeaverError::Validation(format!(
                            "cue `{}` uses unsupported directive `{other}`",
                            path.display()
                        )));
                    }
                }
            }

            if tracks.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "cue `{}` did not define any tracks",
                    path.display()
                )));
            }

            let mut resolved = Vec::with_capacity(tracks.len());
            for (index, track) in tracks.iter().enumerate() {
                let index01_frames = track.index01_frames.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "cue track {} in `{}` is missing INDEX 01",
                        track.number,
                        path.display()
                    ))
                })?;
                if track.pregap_frames > 0 && track.index00_frames.is_some() {
                    return Err(RomWeaverError::Validation(format!(
                        "cue track {} in `{}` uses both INDEX 00 and PREGAP; current chd cue support requires one pregap style",
                        track.number,
                        path.display()
                    )));
                }
                let start_frame = track.index00_frames.unwrap_or(index01_frames);
                let sector_bytes = u64::try_from(track.mode.data_bytes()).unwrap_or(2352);
                let start = track.file_offset_base_bytes + u64::from(start_frame) * sector_bytes;
                let file_end = track.file_offset_base_bytes + track.file_data_len_bytes;
                if start > file_end {
                    return Err(RomWeaverError::Validation(format!(
                        "cue track {} starts past the end of `{}`",
                        track.number,
                        track.file_path.display()
                    )));
                }
                let mut next_start = file_end;
                for candidate in &tracks[index + 1..] {
                    if candidate.file_path != track.file_path
                        || candidate.file_offset_base_bytes != track.file_offset_base_bytes
                    {
                        continue;
                    }
                    if candidate.mode.data_bytes() != track.mode.data_bytes() {
                        return Err(RomWeaverError::Validation(format!(
                            "cue `{}` shares `{}` across tracks with different sector sizes; current chd cue support requires a separate file per sector size",
                            path.display(),
                            track.file_path.display()
                        )));
                    }
                    let candidate_index01 = candidate.index01_frames.ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "cue track {} in `{}` is missing INDEX 01",
                            candidate.number,
                            path.display()
                        ))
                    })?;
                    let candidate_start_frame =
                        candidate.index00_frames.unwrap_or(candidate_index01);
                    next_start = candidate.file_offset_base_bytes
                        + u64::from(candidate_start_frame) * sector_bytes;
                    break;
                }
                if next_start < start {
                    return Err(RomWeaverError::Validation(format!(
                        "cue track {} has descending frame offsets in `{}`",
                        track.number,
                        path.display()
                    )));
                }
                let byte_len = next_start - start;
                if byte_len % sector_bytes != 0 {
                    return Err(RomWeaverError::Validation(format!(
                        "cue track {} length in `{}` is not divisible by {} bytes",
                        track.number,
                        track.file_path.display(),
                        sector_bytes
                    )));
                }
                let frames = u32::try_from(byte_len / sector_bytes).map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "cue track {} is too large for current chd cd support",
                        track.number
                    ))
                })?;
                let pregap_from_index = index01_frames.saturating_sub(start_frame);
                let pregap_has_data = track.index00_frames.is_some() && pregap_from_index > 0;
                let pregap_frames = if pregap_has_data {
                    pregap_from_index
                } else {
                    track.pregap_frames
                };
                resolved.push(DiscTrack {
                    number: track.number,
                    mode: track.mode,
                    file_path: track.file_path.clone(),
                    file_offset_bytes: start,
                    frames,
                    pregap_frames,
                    postgap_frames: track.postgap_frames,
                    pregap_has_data,
                    has_subcode: false,
                    pad_frames: 0,
                    swap_audio_on_read: track.swap_audio_on_read,
                });
            }

            Ok(DiscLayout {
                kind: DiscKind::CdRom,
                tracks: resolved,
            })
        }

        fn parse_gdi_file(&self, path: &Path) -> Result<DiscLayout> {
            #[derive(Clone, Debug)]
            struct PendingTrack {
                number: u32,
                physframeofs: u32,
                mode: DiscTrackMode,
                file_path: PathBuf,
                file_offset_bytes: u64,
                data_frames: u32,
                swap_audio_on_read: bool,
            }

            let gdi_dir = path.parent().unwrap_or_else(|| Path::new("."));
            let text = fs::read_to_string(path)?;
            let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
            let track_count = lines
                .next()
                .ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` is missing its track count header",
                        path.display()
                    ))
                })?
                .parse::<usize>()
                .map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid track count header",
                        path.display()
                    ))
                })?;
            if track_count == 0 {
                return Err(RomWeaverError::Validation(format!(
                    "gdi `{}` does not define any tracks",
                    path.display()
                )));
            }

            let mut tracks = Vec::with_capacity(track_count);
            for line in lines {
                let (number, remainder) = split_token(line).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "invalid gdi track entry in `{}`",
                        path.display()
                    ))
                })?;
                let (physframeofs, remainder) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its physical offset",
                        path.display()
                    ))
                })?;
                let (track_type, remainder) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its track type",
                        path.display()
                    ))
                })?;
                let (sector_size, remainder) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its sector size",
                        path.display()
                    ))
                })?;
                let (name, remainder) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its filename",
                        path.display()
                    ))
                })?;
                let (file_offset, _) = split_token(remainder).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "gdi track entry in `{}` is missing its file offset",
                        path.display()
                    ))
                })?;

                let number = number.parse::<u32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid track number `{number}`",
                        path.display()
                    ))
                })?;
                let physframeofs = physframeofs.parse::<u32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid physical offset `{physframeofs}`",
                        path.display()
                    ))
                })?;
                let track_type = track_type.parse::<u32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid track type `{track_type}`",
                        path.display()
                    ))
                })?;
                let sector_size = sector_size.parse::<u32>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid sector size `{sector_size}`",
                        path.display()
                    ))
                })?;
                let file_offset_bytes = file_offset.parse::<u64>().map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "gdi `{}` has an invalid file offset `{file_offset}`",
                        path.display()
                    ))
                })?;

                let (mode, swap_audio_on_read) = match (track_type, sector_size) {
                    (4, 2352) => (DiscTrackMode::Mode1Raw, false),
                    (4, 2048) => (DiscTrackMode::Mode1, false),
                    (0, 2352) => (DiscTrackMode::Audio, true),
                    _ => {
                        return Err(RomWeaverError::Validation(format!(
                            "gdi `{}` uses unsupported track type/sector-size pair `{track_type}/{sector_size}`",
                            path.display()
                        )));
                    }
                };

                let file_path = gdi_dir.join(name);
                let file_size = fs::metadata(&file_path)?.len();
                if file_offset_bytes > file_size {
                    return Err(RomWeaverError::Validation(format!(
                        "gdi track {} starts past the end of `{}`",
                        number,
                        file_path.display()
                    )));
                }
                let payload_bytes = file_size - file_offset_bytes;
                if payload_bytes % u64::from(sector_size) != 0 {
                    return Err(RomWeaverError::Validation(format!(
                        "gdi track {} length in `{}` is not divisible by {} bytes",
                        number,
                        file_path.display(),
                        sector_size
                    )));
                }
                let data_frames =
                    u32::try_from(payload_bytes / u64::from(sector_size)).map_err(|_| {
                        RomWeaverError::Validation(format!(
                            "gdi track {} is too large for current chd gd-rom support",
                            number
                        ))
                    })?;

                tracks.push(PendingTrack {
                    number,
                    physframeofs,
                    mode,
                    file_path,
                    file_offset_bytes,
                    data_frames,
                    swap_audio_on_read,
                });
            }

            if tracks.len() != track_count {
                return Err(RomWeaverError::Validation(format!(
                    "gdi `{}` declared {} tracks but defined {}",
                    path.display(),
                    track_count,
                    tracks.len()
                )));
            }

            tracks.sort_by_key(|track| track.number);
            for (index, track) in tracks.iter().enumerate() {
                let expected = u32::try_from(index + 1).unwrap_or(u32::MAX);
                if track.number != expected {
                    return Err(RomWeaverError::Validation(format!(
                        "gdi `{}` is missing track {}",
                        path.display(),
                        expected
                    )));
                }
            }

            let mut resolved = Vec::with_capacity(tracks.len());
            for (index, track) in tracks.iter().enumerate() {
                let next_physframeofs = tracks
                    .get(index + 1)
                    .map(|candidate| candidate.physframeofs);
                let pad_frames = next_physframeofs
                    .map(|next| {
                        next.checked_sub(track.physframeofs.saturating_add(track.data_frames))
                            .ok_or_else(|| {
                                RomWeaverError::Validation(format!(
                                    "gdi track {} overlaps the next track in `{}`",
                                    track.number,
                                    path.display()
                                ))
                            })
                    })
                    .transpose()?
                    .unwrap_or(0);

                resolved.push(DiscTrack {
                    number: track.number,
                    mode: track.mode,
                    file_path: track.file_path.clone(),
                    file_offset_bytes: track.file_offset_bytes,
                    frames: track.data_frames.saturating_add(pad_frames),
                    pregap_frames: 0,
                    postgap_frames: 0,
                    pregap_has_data: false,
                    has_subcode: false,
                    pad_frames,
                    swap_audio_on_read: track.swap_audio_on_read,
                });
            }

            Ok(DiscLayout {
                kind: DiscKind::GdRom,
                tracks: resolved,
            })
        }

        fn read_disc_tracks(&self, chd: &ChdReadSession, kind: DiscKind) -> Result<DiscLayout> {
            let mut tracks = Vec::new();
            for index in 0..99_u32 {
                let Some(metadata) = chd.read_metadata(kind.metadata_tag(), index)? else {
                    break;
                };
                let text = String::from_utf8_lossy(&metadata)
                    .trim_end_matches('\0')
                    .to_string();
                let mut number = None;
                let mut mode = None;
                let mut subtype = None;
                let mut frames = None;
                let mut pad_frames = 0_u32;
                let mut pregap = 0_u32;
                let mut pgtype = String::new();
                let mut postgap = 0_u32;

                for field in text.split_whitespace() {
                    let Some((key, value)) = field.split_once(':') else {
                        continue;
                    };
                    match key {
                        "TRACK" => number = value.parse::<u32>().ok(),
                        "TYPE" => mode = Some(self.parse_disc_mode(value)?),
                        "SUBTYPE" => subtype = Some(value.to_ascii_uppercase()),
                        "FRAMES" => frames = value.parse::<u32>().ok(),
                        "PAD" => pad_frames = value.parse::<u32>().unwrap_or(0),
                        "PREGAP" => pregap = value.parse::<u32>().unwrap_or(0),
                        "PGTYPE" => pgtype = value.to_string(),
                        "POSTGAP" => postgap = value.parse::<u32>().unwrap_or(0),
                        _ => {}
                    }
                }

                let number = number.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "invalid cd metadata entry `{text}`: missing track number"
                    ))
                })?;
                let mode = mode.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "invalid cd metadata entry `{text}`: missing track type"
                    ))
                })?;
                let frames = frames.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "invalid cd metadata entry `{text}`: missing frame count"
                    ))
                })?;
                let subtype = subtype.unwrap_or_else(|| "NONE".to_string());
                tracks.push(DiscTrack {
                    number,
                    mode,
                    file_path: PathBuf::new(),
                    file_offset_bytes: 0,
                    frames,
                    pregap_frames: pregap,
                    postgap_frames: postgap,
                    pregap_has_data: pgtype.starts_with('V'),
                    has_subcode: subtype != "NONE",
                    pad_frames,
                    swap_audio_on_read: false,
                });
            }

            if tracks.is_empty() {
                return Err(RomWeaverError::Validation(
                    match kind {
                        DiscKind::CdRom => "cd chd is missing CD track metadata",
                        DiscKind::GdRom => "gd chd is missing GD track metadata",
                    }
                    .into(),
                ));
            }

            Ok(DiscLayout { kind, tracks })
        }

        fn create_temp_file_path(&self, stem: &str, extension: &str) -> PathBuf {
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default();
            Self::runtime_temp_dir().join(format!(
                "rom-weaver-{stem}-{}-{timestamp}{extension}",
                Self::runtime_process_id()
            ))
        }

        fn runtime_temp_dir() -> PathBuf {
            #[cfg(target_family = "wasm")]
            {
                if let Some(path) = std::env::var_os("ROM_WEAVER_TMPDIR")
                    && !path.is_empty()
                {
                    return PathBuf::from(path);
                }

                return PathBuf::from("/tmp");
            }

            #[cfg(not(target_family = "wasm"))]
            {
                std::env::temp_dir()
            }
        }

        fn runtime_process_id() -> u32 {
            #[cfg(target_family = "wasm")]
            {
                return 1;
            }

            #[cfg(not(target_family = "wasm"))]
            {
                std::process::id()
            }
        }

        fn track_output_name(&self, stem: &str, track_number: u32) -> String {
            format!("{stem}.track{track_number:02}.bin")
        }

        fn materialize_disc_image(&self, layout: &DiscLayout) -> Result<PathBuf> {
            let temp_path = self.create_temp_file_path(
                match layout.kind {
                    DiscKind::CdRom => "cd-input",
                    DiscKind::GdRom => "gd-input",
                },
                ".bin",
            );
            let mut writer = BufWriter::new(File::create(&temp_path)?);
            let mut frame = vec![0_u8; Self::CD_FRAME_BYTES as usize];
            let zero_frame = frame.clone();

            for track in &layout.tracks {
                let mut reader = BufReader::new(File::open(&track.file_path)?);
                reader.seek(SeekFrom::Start(track.file_offset_bytes))?;
                let mut data = vec![0_u8; track.mode.data_bytes()];
                let data_frames = track.frames.saturating_sub(track.pad_frames);
                for _ in 0..data_frames {
                    reader.read_exact(&mut data)?;
                    if track.swap_audio_on_read {
                        track.mode.swap_audio_bytes(&mut data);
                    }
                    frame.fill(0);
                    frame[..data.len()].copy_from_slice(&data);
                    writer.write_all(&frame)?;
                }
                for _ in 0..track.pad_frames {
                    writer.write_all(&zero_frame)?;
                }
            }

            writer.flush()?;
            Ok(temp_path)
        }

        fn extract_cd(
            &self,
            chd: ChdReadSession,
            request: &ContainerExtractRequest,
            execution: rom_weaver_core::ThreadExecution,
        ) -> Result<OperationReport> {
            let header = chd.header();
            if header.unit_bytes != Self::CD_FRAME_BYTES {
                return Err(RomWeaverError::Validation(format!(
                    "cd chd uses {}-byte units; current extract expects {}-byte frames",
                    header.unit_bytes,
                    Self::CD_FRAME_BYTES
                )));
            }

            let layout = self.read_disc_tracks(&chd, DiscKind::CdRom)?;
            fs::create_dir_all(&request.out_dir)?;
            let stem = request
                .source
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("output");
            let cue_path = request.out_dir.join(format!("{stem}.cue"));
            let temp_path = self.create_temp_file_path("cd-extract", ".bin");
            let extract_result = chd.extract_to_file(&temp_path, execution.effective_threads);
            if extract_result.is_err() {
                let _ = fs::remove_file(&temp_path);
            }
            let _ = extract_result?;

            let first_data_bytes = layout
                .tracks
                .first()
                .map(|track| track.mode.data_bytes())
                .unwrap_or(2352);
            let natural_single_bin = layout
                .tracks
                .iter()
                .all(|track| track.mode.data_bytes() == first_data_bytes);
            let single_bin = natural_single_bin && !request.split_bin;
            let selection_requested = !request.selections.is_empty();
            let cue_name = format!("{stem}.cue");
            let mut selections = SelectionMatcher::new(&request.selections);
            let write_cue = selections.matches(&cue_name);
            let single_bin_name = format!("{stem}.bin");
            let mut write_single_bin = single_bin && selections.matches(&single_bin_name);
            let mut split_track_names = Vec::new();
            let mut write_split_tracks = Vec::new();
            if !single_bin {
                for track in &layout.tracks {
                    let track_name = self.track_output_name(stem, track.number);
                    write_split_tracks.push(selections.matches(&track_name));
                    split_track_names.push(track_name);
                }
            }
            if selection_requested && write_cue {
                let any_selected = if single_bin {
                    write_single_bin
                } else {
                    write_split_tracks.iter().any(|selected| *selected)
                };
                if !any_selected {
                    if single_bin {
                        write_single_bin = true;
                    } else {
                        for selected in &mut write_split_tracks {
                            *selected = true;
                        }
                    }
                }
            }
            selections.ensure_all_matched()?;

            let build_result: Result<(bool, Vec<PathBuf>, bool)> = (|| {
                let mut reader = BufReader::new(File::open(&temp_path)?);
                let mut frame = vec![0_u8; Self::CD_FRAME_BYTES as usize];
                let mut omitted_subcode = false;
                let mut produced_outputs = Vec::new();
                let mut cue_writer = if write_cue {
                    produced_outputs.push(cue_path.clone());
                    Some(BufWriter::new(File::create(&cue_path)?))
                } else {
                    None
                };
                let mut wrote_single_bin_output = false;

                if single_bin {
                    let bin_path = request.out_dir.join(&single_bin_name);
                    let mut bin_writer = if write_single_bin {
                        wrote_single_bin_output = true;
                        produced_outputs.push(bin_path.clone());
                        Some(BufWriter::new(File::create(&bin_path)?))
                    } else {
                        None
                    };
                    if let Some(writer) = cue_writer.as_mut() {
                        writer
                            .write_all(format!("FILE \"{single_bin_name}\" BINARY\n").as_bytes())?;
                    }
                    let mut output_frame_offset = 0_u32;
                    for track in &layout.tracks {
                        if let Some(writer) = cue_writer.as_mut() {
                            writer.write_all(
                                format!("  TRACK {:02} {}\n", track.number, track.mode.cue_label())
                                    .as_bytes(),
                            )?;
                            if track.pregap_frames > 0 && track.pregap_has_data {
                                writer.write_all(
                                    format!(
                                        "    INDEX 00 {}\n",
                                        self.format_msf(output_frame_offset)
                                    )
                                    .as_bytes(),
                                )?;
                                writer.write_all(
                                    format!(
                                        "    INDEX 01 {}\n",
                                        self.format_msf(output_frame_offset + track.pregap_frames)
                                    )
                                    .as_bytes(),
                                )?;
                            } else if track.pregap_frames > 0 {
                                writer.write_all(
                                    format!(
                                        "    PREGAP {}\n",
                                        self.format_msf(track.pregap_frames)
                                    )
                                    .as_bytes(),
                                )?;
                                writer.write_all(
                                    format!(
                                        "    INDEX 01 {}\n",
                                        self.format_msf(output_frame_offset)
                                    )
                                    .as_bytes(),
                                )?;
                            } else {
                                writer.write_all(
                                    format!(
                                        "    INDEX 01 {}\n",
                                        self.format_msf(output_frame_offset)
                                    )
                                    .as_bytes(),
                                )?;
                            }
                            if track.postgap_frames > 0 {
                                writer.write_all(
                                    format!(
                                        "    POSTGAP {}\n",
                                        self.format_msf(track.postgap_frames)
                                    )
                                    .as_bytes(),
                                )?;
                            }
                        }

                        let data_frames = track.frames.saturating_sub(track.pad_frames);
                        for _ in 0..data_frames {
                            reader.read_exact(&mut frame)?;
                            let data = &mut frame[..track.mode.data_bytes()];
                            if write_single_bin && track.has_subcode {
                                omitted_subcode = true;
                            }
                            track.mode.swap_audio_bytes(data);
                            if let Some(writer) = bin_writer.as_mut() {
                                writer.write_all(data)?;
                            }
                        }
                        for _ in 0..track.pad_frames {
                            reader.read_exact(&mut frame)?;
                        }
                        output_frame_offset = output_frame_offset.saturating_add(data_frames);
                    }
                    if let Some(writer) = bin_writer.as_mut() {
                        writer.flush()?;
                    }
                } else {
                    for (track_index, track) in layout.tracks.iter().enumerate() {
                        let track_name = &split_track_names[track_index];
                        let track_selected = write_split_tracks[track_index];
                        let track_path = request.out_dir.join(track_name);
                        if let Some(writer) = cue_writer.as_mut() {
                            if track_selected {
                                writer.write_all(
                                    format!("FILE \"{track_name}\" BINARY\n").as_bytes(),
                                )?;
                                writer.write_all(
                                    format!(
                                        "  TRACK {:02} {}\n",
                                        track.number,
                                        track.mode.cue_label()
                                    )
                                    .as_bytes(),
                                )?;
                                if track.pregap_frames > 0 && track.pregap_has_data {
                                    writer.write_all(b"    INDEX 00 00:00:00\n")?;
                                    writer.write_all(
                                        format!(
                                            "    INDEX 01 {}\n",
                                            self.format_msf(track.pregap_frames)
                                        )
                                        .as_bytes(),
                                    )?;
                                } else if track.pregap_frames > 0 {
                                    writer.write_all(
                                        format!(
                                            "    PREGAP {}\n",
                                            self.format_msf(track.pregap_frames)
                                        )
                                        .as_bytes(),
                                    )?;
                                    writer.write_all(b"    INDEX 01 00:00:00\n")?;
                                } else {
                                    writer.write_all(b"    INDEX 01 00:00:00\n")?;
                                }
                                if track.postgap_frames > 0 {
                                    writer.write_all(
                                        format!(
                                            "    POSTGAP {}\n",
                                            self.format_msf(track.postgap_frames)
                                        )
                                        .as_bytes(),
                                    )?;
                                }
                            }
                        }

                        let mut track_writer = if track_selected {
                            produced_outputs.push(track_path.clone());
                            Some(BufWriter::new(File::create(track_path)?))
                        } else {
                            None
                        };
                        let data_frames = track.frames.saturating_sub(track.pad_frames);
                        for _ in 0..data_frames {
                            reader.read_exact(&mut frame)?;
                            let data = &mut frame[..track.mode.data_bytes()];
                            if track_selected && track.has_subcode {
                                omitted_subcode = true;
                            }
                            track.mode.swap_audio_bytes(data);
                            if let Some(writer) = track_writer.as_mut() {
                                writer.write_all(data)?;
                            }
                        }
                        for _ in 0..track.pad_frames {
                            reader.read_exact(&mut frame)?;
                        }
                        if let Some(writer) = track_writer.as_mut() {
                            writer.flush()?;
                        }
                    }
                }

                if let Some(writer) = cue_writer.as_mut() {
                    writer.flush()?;
                }
                Ok((omitted_subcode, produced_outputs, wrote_single_bin_output))
            })();

            let _ = fs::remove_file(&temp_path);
            let (omitted_subcode, produced_outputs, wrote_single_bin_output) = build_result?;
            if selection_requested && produced_outputs.is_empty() {
                return Err(RomWeaverError::Validation(
                    "requested selections resolved to no extractable cd outputs".into(),
                ));
            }
            let suffix = if omitted_subcode {
                "; subcode data was omitted from cue/bin output"
            } else {
                ""
            };

            let split_bin_suffix = if request.split_bin {
                let emitted_files = produced_outputs
                    .iter()
                    .map(|path| {
                        path.strip_prefix(&request.out_dir)
                            .unwrap_or(path.as_path())
                            .to_string_lossy()
                            .replace('\\', "/")
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!("; splitbin=true emitted_files={emitted_files}")
            } else {
                String::new()
            };

            let label = if !selection_requested && wrote_single_bin_output {
                let bin_path = request.out_dir.join(&single_bin_name);
                format!(
                    "extracted `{}` to `{}` and `{}` (cd, {}){}{}",
                    request.source.display(),
                    cue_path.display(),
                    bin_path.display(),
                    self.header_codec_label(header),
                    suffix,
                    split_bin_suffix
                )
            } else if !selection_requested {
                format!(
                    "extracted `{}` to `{}` and per-track bin files (cd, {}){}{}",
                    request.source.display(),
                    cue_path.display(),
                    self.header_codec_label(header),
                    suffix,
                    split_bin_suffix
                )
            } else {
                let outputs = produced_outputs
                    .iter()
                    .map(|path| format!("`{}`", path.display()))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "extracted `{}` to selected outputs: {} (cd, {}){}{}",
                    request.source.display(),
                    outputs,
                    self.header_codec_label(header),
                    suffix,
                    split_bin_suffix
                )
            };

            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "extract",
                label,
                Some(100.0),
                Some(execution),
            ))
        }

        fn extract_gd(
            &self,
            chd: ChdReadSession,
            request: &ContainerExtractRequest,
            execution: rom_weaver_core::ThreadExecution,
        ) -> Result<OperationReport> {
            let header = chd.header();
            if header.unit_bytes != Self::CD_FRAME_BYTES {
                return Err(RomWeaverError::Validation(format!(
                    "gd chd uses {}-byte units; current extract expects {}-byte frames",
                    header.unit_bytes,
                    Self::CD_FRAME_BYTES
                )));
            }

            let layout = self.read_disc_tracks(&chd, DiscKind::GdRom)?;
            fs::create_dir_all(&request.out_dir)?;
            let stem = request
                .source
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("output");
            let gdi_path = request.out_dir.join(format!("{stem}.gdi"));
            let temp_path = self.create_temp_file_path("gd-extract", ".bin");
            let extract_result = chd.extract_to_file(&temp_path, execution.effective_threads);
            if extract_result.is_err() {
                let _ = fs::remove_file(&temp_path);
            }
            let _ = extract_result?;

            let selection_requested = !request.selections.is_empty();
            let gdi_name = format!("{stem}.gdi");
            let mut selections = SelectionMatcher::new(&request.selections);
            let write_gdi = selections.matches(&gdi_name);
            let mut track_names = Vec::with_capacity(layout.tracks.len());
            let mut write_tracks = Vec::with_capacity(layout.tracks.len());
            for track in &layout.tracks {
                let track_name = self.track_output_name(stem, track.number);
                write_tracks.push(selections.matches(&track_name));
                track_names.push(track_name);
            }
            if selection_requested && write_gdi && !write_tracks.iter().any(|selected| *selected) {
                for selected in &mut write_tracks {
                    *selected = true;
                }
            }
            selections.ensure_all_matched()?;

            let build_result: Result<(bool, Vec<PathBuf>)> = (|| {
                let mut reader = BufReader::new(File::open(&temp_path)?);
                let mut frame = vec![0_u8; Self::CD_FRAME_BYTES as usize];
                let mut omitted_subcode = false;
                let mut physframeofs = 0_u32;
                let mut produced_outputs = Vec::new();
                let mut gdi_lines = Vec::new();

                for (track_index, track) in layout.tracks.iter().enumerate() {
                    let (track_type, sector_size) = track.mode.gdi_track_descriptor()?;
                    let track_name = &track_names[track_index];
                    let track_selected = write_tracks[track_index];
                    if track_selected {
                        gdi_lines.push(format!(
                            "{} {} {} {} {} 0",
                            track.number, physframeofs, track_type, sector_size, track_name
                        ));
                    }
                    let track_path = request.out_dir.join(track_name);
                    let mut track_writer = if track_selected {
                        produced_outputs.push(track_path.clone());
                        Some(BufWriter::new(File::create(track_path)?))
                    } else {
                        None
                    };
                    let data_frames = track.frames.saturating_sub(track.pad_frames);
                    for _ in 0..data_frames {
                        reader.read_exact(&mut frame)?;
                        let data = &mut frame[..track.mode.data_bytes()];
                        if track_selected && track.has_subcode {
                            omitted_subcode = true;
                        }
                        track.mode.swap_audio_bytes(data);
                        if let Some(writer) = track_writer.as_mut() {
                            writer.write_all(data)?;
                        }
                    }
                    for _ in 0..track.pad_frames {
                        reader.read_exact(&mut frame)?;
                    }
                    if let Some(writer) = track_writer.as_mut() {
                        writer.flush()?;
                    }
                    physframeofs = physframeofs.saturating_add(track.frames);
                }

                if write_gdi {
                    let mut gdi_writer = BufWriter::new(File::create(&gdi_path)?);
                    produced_outputs.push(gdi_path.clone());
                    gdi_writer.write_all(format!("{}\n", gdi_lines.len()).as_bytes())?;
                    for line in &gdi_lines {
                        gdi_writer.write_all(line.as_bytes())?;
                        gdi_writer.write_all(b"\n")?;
                    }
                    gdi_writer.flush()?;
                }

                Ok((omitted_subcode, produced_outputs))
            })();

            let _ = fs::remove_file(&temp_path);
            let (omitted_subcode, produced_outputs) = build_result?;
            if selection_requested && produced_outputs.is_empty() {
                return Err(RomWeaverError::Validation(
                    "requested selections resolved to no extractable gd outputs".into(),
                ));
            }
            let suffix = if omitted_subcode {
                "; subcode data was omitted from gdi output"
            } else {
                ""
            };

            let label = if selection_requested {
                let outputs = produced_outputs
                    .iter()
                    .map(|path| format!("`{}`", path.display()))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "extracted `{}` to selected outputs: {} (gd, {}){}",
                    request.source.display(),
                    outputs,
                    self.header_codec_label(header),
                    suffix
                )
            } else {
                format!(
                    "extracted `{}` to `{}` and per-track gd files (gd, {}){}",
                    request.source.display(),
                    gdi_path.display(),
                    self.header_codec_label(header),
                    suffix
                )
            };

            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "extract",
                label,
                Some(100.0),
                Some(execution),
            ))
        }

        fn create_uncompressed_rust_raw(
            &self,
            input: &Path,
            output: &Path,
            logical_bytes: u64,
            create_kind: &ChdCreateKind,
        ) -> Result<ChdHeader> {
            if matches!(create_kind, ChdCreateKind::Av(_)) {
                return Err(RomWeaverError::Unsupported(
                    "rust chd create currently supports only raw/dvd/hd/disc `store` mode".into(),
                ));
            }

            let hunk_bytes = self.hunk_bytes(create_kind, logical_bytes, ChdCodec::NONE);
            let unit_bytes = self.unit_bytes(create_kind);
            if hunk_bytes == 0 || unit_bytes == 0 || hunk_bytes % unit_bytes != 0 {
                return Err(RomWeaverError::Validation(
                    "invalid CHD geometry for rust create".into(),
                ));
            }

            let hunk_count_u64 = logical_bytes.div_ceil(u64::from(hunk_bytes));
            let hunk_count = u32::try_from(hunk_count_u64).map_err(|_| {
                RomWeaverError::Validation(
                    "input is too large for CHD v5 hunk table limits".to_string(),
                )
            })?;
            let map_offset = Self::CHD_V5_HEADER_BYTES;
            let map_bytes = hunk_count_u64
                .checked_mul(4)
                .ok_or_else(|| RomWeaverError::Validation("chd map size overflow".to_string()))?;
            let after_map = map_offset.checked_add(map_bytes).ok_or_else(|| {
                RomWeaverError::Validation("chd file layout overflow".to_string())
            })?;
            let data_offset = if hunk_count == 0 {
                after_map
            } else {
                after_map.div_ceil(u64::from(hunk_bytes)) * u64::from(hunk_bytes)
            };
            let first_hunk_entry = u32::try_from(data_offset / u64::from(hunk_bytes))
                .map_err(|_| RomWeaverError::Validation("chd map entry overflow".to_string()))?;

            let mut output_file = File::options()
                .create(true)
                .write(true)
                .read(true)
                .truncate(true)
                .open(output)
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to create `{}`: {error}",
                        output.display()
                    ))
                })?;

            let header = self.build_chd_v5_header(
                logical_bytes,
                map_offset,
                hunk_bytes,
                unit_bytes,
                [ChdCodec::NONE; CHD_MAX_COMPRESSORS],
                None,
            );
            output_file.write_all(&header).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to write CHD header to `{}`: {error}",
                    output.display()
                ))
            })?;

            for hunk_index in 0..hunk_count {
                let entry = first_hunk_entry
                    .checked_add(hunk_index)
                    .ok_or_else(|| RomWeaverError::Validation("chd map entry overflow".into()))?;
                output_file
                    .write_all(&entry.to_be_bytes())
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to write CHD map to `{}`: {error}",
                            output.display()
                        ))
                    })?;
            }

            let mut pad_bytes = data_offset.saturating_sub(after_map);
            if pad_bytes > 0 {
                let padding = [0_u8; 8192];
                while pad_bytes > 0 {
                    let write_len =
                        usize::try_from(pad_bytes.min(padding.len() as u64)).map_err(|_| {
                            RomWeaverError::Validation("chd alignment padding overflow".to_string())
                        })?;
                    output_file
                        .write_all(&padding[..write_len])
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "failed to write CHD alignment padding to `{}`: {error}",
                                output.display()
                            ))
                        })?;
                    pad_bytes -= write_len as u64;
                }
            }

            let mut reader = BufReader::new(File::open(input).map_err(|error| {
                RomWeaverError::Validation(format!("failed to open `{}`: {error}", input.display()))
            })?);
            let mut buffer = vec![0_u8; usize::try_from(hunk_bytes).unwrap_or(4096)];
            let mut remaining = logical_bytes;
            for _ in 0..hunk_count {
                buffer.fill(0);
                let read_len =
                    usize::try_from(remaining.min(u64::from(hunk_bytes))).map_err(|_| {
                        RomWeaverError::Validation(
                            "decoded CHD chunk exceeded addressable memory".to_string(),
                        )
                    })?;
                reader
                    .read_exact(&mut buffer[..read_len])
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to read source `{}`: {error}",
                            input.display()
                        ))
                    })?;
                output_file.write_all(&buffer).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD data to `{}`: {error}",
                        output.display()
                    ))
                })?;
                remaining = remaining.saturating_sub(read_len as u64);
            }
            let metadata_entries = self.rust_metadata_entries(create_kind)?;
            if let Some(meta_offset) =
                self.append_rust_metadata(&mut output_file, output, &metadata_entries)?
            {
                self.patch_chd_header_u64(
                    &mut output_file,
                    output,
                    Self::CHD_V5_HEADER_META_OFFSET,
                    meta_offset,
                    "metadata",
                )?;
            }
            self.patch_chd_header_sha1s(
                &mut output_file,
                output,
                input,
                logical_bytes,
                &metadata_entries,
            )?;
            output_file.flush().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to flush `{}`: {error}",
                    output.display()
                ))
            })?;

            Ok(ChdHeader {
                version: 5,
                logical_bytes,
                hunk_bytes,
                hunk_count,
                unit_bytes,
                unit_count: logical_bytes.div_ceil(u64::from(unit_bytes)),
                compressed: false,
                compression: [ChdCodec::NONE; CHD_MAX_COMPRESSORS],
            })
        }

        fn hunk_hash_key(bytes: &[u8]) -> HunkHashKey {
            let mut sha1 = [0_u8; 20];
            let digest = Sha1::digest(bytes);
            sha1.copy_from_slice(digest.as_slice());
            HunkHashKey {
                crc16: Self::crc16_ibm3740(bytes),
                sha1,
            }
        }

        fn load_parent_reuse_index(
            &self,
            parent_source: &Path,
            expected_unit_bytes: u32,
            expected_hunk_bytes: u32,
        ) -> Result<ParentReuseIndex> {
            let mut parent =
                ChdReadSession::open_rust_chd(parent_source, None).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to open parent chd `{}` for differential create: {error}",
                        parent_source.display()
                    ))
                })?;
            let parent_header = parent.header();
            let parent_sha1 = parent_header.sha1().ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "parent chd `{}` does not expose a sha1 in its header",
                    parent_source.display()
                ))
            })?;
            if parent_header.unit_bytes() != expected_unit_bytes {
                return Err(RomWeaverError::Validation(format!(
                    "parent chd `{}` unit size {} does not match child unit size {}",
                    parent_source.display(),
                    parent_header.unit_bytes(),
                    expected_unit_bytes
                )));
            }
            if parent_header.hunk_size() != expected_hunk_bytes {
                return Err(RomWeaverError::Validation(format!(
                    "parent chd `{}` hunk size {} does not match child hunk size {}",
                    parent_source.display(),
                    parent_header.hunk_size(),
                    expected_hunk_bytes
                )));
            }
            if expected_unit_bytes == 0 || expected_hunk_bytes % expected_unit_bytes != 0 {
                return Err(RomWeaverError::Validation(
                    "invalid parent/child geometry for differential create".to_string(),
                ));
            }
            let units_per_hunk = expected_hunk_bytes / expected_unit_bytes;
            let mut by_hash = BTreeMap::new();
            let mut hunk_buffer = parent.get_hunksized_buffer();
            let mut compressed_buffer = Vec::new();
            for hunk_index in 0..parent_header.hunk_count() {
                let mut hunk = parent.hunk(hunk_index).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to read parent hunk {hunk_index} from `{}`: {error}",
                        parent_source.display()
                    ))
                })?;
                hunk.read_hunk_in(&mut compressed_buffer, &mut hunk_buffer)
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to decode parent hunk {hunk_index} from `{}`: {error}",
                            parent_source.display()
                        ))
                    })?;
                let key = Self::hunk_hash_key(&hunk_buffer);
                let parent_unit = u64::from(hunk_index).saturating_mul(u64::from(units_per_hunk));
                by_hash.entry(key).or_insert(parent_unit);
            }
            Ok(ParentReuseIndex {
                by_hash,
                sha1: parent_sha1,
            })
        }

        fn force_compressed_payload_for_primary_codec(primary_codec: ChdCodec) -> bool {
            matches!(primary_codec, ChdCodec::HUFFMAN | ChdCodec::AVHUFF)
        }

        fn prefer_compressed_payload(
            &self,
            primary_codec: ChdCodec,
            compressed_len: usize,
            raw_len: usize,
        ) -> bool {
            compressed_len < raw_len
                || Self::force_compressed_payload_for_primary_codec(primary_codec)
        }

        fn create_compressed_rust_raw(
            &self,
            input: &Path,
            output: &Path,
            logical_bytes: u64,
            create_kind: &ChdCreateKind,
            codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
            compression_level: i32,
            thread_count: usize,
            parent_source: Option<&Path>,
        ) -> Result<ChdHeader> {
            let mut active_codecs = Vec::new();
            for (index, codec) in codecs.into_iter().enumerate() {
                if codec == ChdCodec::NONE {
                    break;
                }
                if !self.supports_create_codec(create_kind, codec) {
                    return Err(RomWeaverError::Unsupported(format!(
                        "chd codec `{}` is not valid for {} media",
                        self.codec_label(codec),
                        self.media_label(self.media_kind_from_create_kind(create_kind))
                    )));
                }
                active_codecs.push((index as u8, codec));
            }
            if active_codecs.is_empty() {
                return Err(RomWeaverError::Validation(
                    "compressed rust CHD create requires at least one codec".to_string(),
                ));
            }
            let encodable_codecs = active_codecs
                .iter()
                .copied()
                .filter(|(_, codec)| self.supports_rust_encode_codec(create_kind, *codec))
                .collect::<Vec<_>>();
            let primary_codec = active_codecs[0].1;

            let hunk_bytes = self.hunk_bytes(create_kind, logical_bytes, primary_codec);
            let unit_bytes = self.unit_bytes(create_kind);
            if hunk_bytes == 0 || unit_bytes == 0 || hunk_bytes % unit_bytes != 0 {
                return Err(RomWeaverError::Validation(
                    "invalid CHD geometry for rust compressed create".into(),
                ));
            }

            let hunk_count_u64 = logical_bytes.div_ceil(u64::from(hunk_bytes));
            let hunk_count = u32::try_from(hunk_count_u64).map_err(|_| {
                RomWeaverError::Validation(
                    "input is too large for CHD v5 hunk table limits".to_string(),
                )
            })?;
            let hunk_count_usize = usize::try_from(hunk_count_u64).map_err(|_| {
                RomWeaverError::Validation("CHD hunk count exceeded addressable memory".to_string())
            })?;
            let hunk_bytes_usize = usize::try_from(hunk_bytes).map_err(|_| {
                RomWeaverError::Validation("CHD hunk size exceeded addressable memory".to_string())
            })?;
            let parent_reuse = match parent_source {
                Some(parent_source) => {
                    Some(self.load_parent_reuse_index(parent_source, unit_bytes, hunk_bytes)?)
                }
                None => None,
            };
            let parent_sha1 = parent_reuse.as_ref().map(|value| value.sha1);

            let mut output_file = File::options()
                .create(true)
                .write(true)
                .read(true)
                .truncate(true)
                .open(output)
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to create `{}`: {error}",
                        output.display()
                    ))
                })?;
            let placeholder_header = self.build_chd_v5_header(
                logical_bytes,
                0,
                hunk_bytes,
                unit_bytes,
                codecs,
                parent_sha1,
            );
            output_file
                .write_all(&placeholder_header)
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD header to `{}`: {error}",
                        output.display()
                    ))
                })?;

            let mut source = BufReader::new(File::open(input).map_err(|error| {
                RomWeaverError::Validation(format!("failed to open `{}`: {error}", input.display()))
            })?);
            let effective_threads = thread_count.max(1).min(hunk_count_usize.max(1));
            let pool = if effective_threads > 1 {
                Some(
                    rayon::ThreadPoolBuilder::new()
                        .num_threads(effective_threads)
                        .build()
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "failed to build CHD rust create pool (threads={}): {error}",
                                effective_threads
                            ))
                        })?,
                )
            } else {
                None
            };
            let batch_size = effective_threads.saturating_mul(4).max(1);
            let mut entries = Vec::with_capacity(hunk_count_usize);
            let mut remaining = logical_bytes;
            let mut current_offset = Self::CHD_V5_HEADER_BYTES;
            let mut self_hunks_by_hash = BTreeMap::<HunkHashKey, u64>::new();
            let parent_hunks_by_hash = parent_reuse.as_ref().map(|value| &value.by_hash);
            let mut next_hunk = 0usize;
            while next_hunk < hunk_count_usize {
                let this_batch = (hunk_count_usize - next_hunk).min(batch_size);
                enum BatchHunkEntry {
                    SelfCopy(u64),
                    ParentCopy(u64),
                    Data(Vec<u8>),
                }
                let mut batch_hunks = Vec::with_capacity(this_batch);
                for batch_index in 0..this_batch {
                    let mut hunk = vec![0_u8; hunk_bytes_usize];
                    let read_len =
                        usize::try_from(remaining.min(u64::from(hunk_bytes))).map_err(|_| {
                            RomWeaverError::Validation(
                                "decoded CHD chunk exceeded addressable memory".to_string(),
                            )
                        })?;
                    source.read_exact(&mut hunk[..read_len]).map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to read source `{}`: {error}",
                            input.display()
                        ))
                    })?;
                    remaining = remaining.saturating_sub(read_len as u64);
                    let key = Self::hunk_hash_key(&hunk);
                    if let Some(&other_hunk) = self_hunks_by_hash.get(&key) {
                        batch_hunks.push(BatchHunkEntry::SelfCopy(other_hunk));
                        continue;
                    }
                    if let Some(parent_hunks_by_hash) = parent_hunks_by_hash
                        && let Some(&parent_unit) = parent_hunks_by_hash.get(&key)
                    {
                        batch_hunks.push(BatchHunkEntry::ParentCopy(parent_unit));
                        continue;
                    }
                    let hunk_index = next_hunk.saturating_add(batch_index);
                    self_hunks_by_hash.insert(key, hunk_index as u64);
                    batch_hunks.push(BatchHunkEntry::Data(hunk));
                }

                let mut data_hunks = Vec::<(usize, Vec<u8>)>::new();
                for (index, entry) in batch_hunks.iter_mut().enumerate() {
                    if let BatchHunkEntry::Data(hunk) = entry {
                        data_hunks.push((index, std::mem::take(hunk)));
                    }
                }
                let compressed_hunks: Vec<Result<(usize, u8, Vec<u8>, u16)>> = if let Some(pool) =
                    &pool
                {
                    if data_hunks.len() > 1 {
                        pool.install(|| {
                            data_hunks
                                .into_par_iter()
                                .map(|(index, hunk)| {
                                    let crc = Self::crc16_ibm3740(&hunk);
                                    let mut best: Option<(u8, Vec<u8>)> = None;
                                    for (codec_slot, codec) in &encodable_codecs {
                                        let compressed = self.compress_rust_hunk(
                                            create_kind,
                                            *codec,
                                            compression_level,
                                            &hunk,
                                        )?;
                                        if best
                                            .as_ref()
                                            .map(|(_, candidate)| {
                                                compressed.len() < candidate.len()
                                            })
                                            .unwrap_or(true)
                                        {
                                            best = Some((*codec_slot, compressed));
                                        }
                                    }
                                    let (compression_type, payload) = best
                                        .filter(|(_, compressed)| {
                                            self.prefer_compressed_payload(
                                                primary_codec,
                                                compressed.len(),
                                                hunk.len(),
                                            )
                                        })
                                        .unwrap_or((Self::CHD_V5_MAP_TYPE_UNCOMPRESSED, hunk));
                                    Ok((index, compression_type, payload, crc))
                                })
                                .collect()
                        })
                    } else {
                        data_hunks
                            .into_iter()
                            .map(|(index, hunk)| {
                                let crc = Self::crc16_ibm3740(&hunk);
                                let mut best: Option<(u8, Vec<u8>)> = None;
                                for (codec_slot, codec) in &encodable_codecs {
                                    let compressed = self.compress_rust_hunk(
                                        create_kind,
                                        *codec,
                                        compression_level,
                                        &hunk,
                                    )?;
                                    if best
                                        .as_ref()
                                        .map(|(_, candidate)| compressed.len() < candidate.len())
                                        .unwrap_or(true)
                                    {
                                        best = Some((*codec_slot, compressed));
                                    }
                                }
                                let (compression_type, payload) = best
                                    .filter(|(_, compressed)| {
                                        self.prefer_compressed_payload(
                                            primary_codec,
                                            compressed.len(),
                                            hunk.len(),
                                        )
                                    })
                                    .unwrap_or((Self::CHD_V5_MAP_TYPE_UNCOMPRESSED, hunk));
                                Ok((index, compression_type, payload, crc))
                            })
                            .collect()
                    }
                } else {
                    data_hunks
                        .into_iter()
                        .map(|(index, hunk)| {
                            let crc = Self::crc16_ibm3740(&hunk);
                            let mut best: Option<(u8, Vec<u8>)> = None;
                            for (codec_slot, codec) in &encodable_codecs {
                                let compressed = self.compress_rust_hunk(
                                    create_kind,
                                    *codec,
                                    compression_level,
                                    &hunk,
                                )?;
                                if best
                                    .as_ref()
                                    .map(|(_, candidate)| compressed.len() < candidate.len())
                                    .unwrap_or(true)
                                {
                                    best = Some((*codec_slot, compressed));
                                }
                            }
                            let (compression_type, payload) = best
                                .filter(|(_, compressed)| {
                                    self.prefer_compressed_payload(
                                        primary_codec,
                                        compressed.len(),
                                        hunk.len(),
                                    )
                                })
                                .unwrap_or((Self::CHD_V5_MAP_TYPE_UNCOMPRESSED, hunk));
                            Ok((index, compression_type, payload, crc))
                        })
                        .collect()
                };
                let mut data_results = vec![None; batch_hunks.len()];
                for result in compressed_hunks {
                    let (index, compression_type, payload, crc16) = result?;
                    data_results[index] = Some((compression_type, payload, crc16));
                }

                for (index, entry) in batch_hunks.into_iter().enumerate() {
                    match entry {
                        BatchHunkEntry::SelfCopy(other_hunk) => {
                            entries.push(RustCompressedHunkEntry {
                                compression_type: Self::CHD_V5_MAP_TYPE_SELF,
                                offset: other_hunk,
                                length: 0,
                                crc16: 0,
                            })
                        }
                        BatchHunkEntry::ParentCopy(parent_unit) => {
                            entries.push(RustCompressedHunkEntry {
                                compression_type: Self::CHD_V5_MAP_TYPE_PARENT,
                                offset: parent_unit,
                                length: 0,
                                crc16: 0,
                            })
                        }
                        BatchHunkEntry::Data(_) => {
                            let Some((compression_type, payload, crc16)) =
                                data_results[index].take()
                            else {
                                return Err(RomWeaverError::Validation(
                                    "internal CHD compression result mismatch".to_string(),
                                ));
                            };
                            let length = u32::try_from(payload.len()).map_err(|_| {
                                RomWeaverError::Validation(
                                    "compressed CHD chunk exceeded u32 size".into(),
                                )
                            })?;
                            if length > 0x00FF_FFFF {
                                return Err(RomWeaverError::Validation(format!(
                                    "compressed CHD chunk length {length} exceeds v5 map limit"
                                )));
                            }
                            output_file.write_all(&payload).map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "failed to write CHD data to `{}`: {error}",
                                    output.display()
                                ))
                            })?;
                            entries.push(RustCompressedHunkEntry {
                                compression_type,
                                offset: current_offset,
                                length,
                                crc16,
                            });
                            current_offset = current_offset.saturating_add(u64::from(length));
                        }
                    }
                }
                next_hunk += this_batch;
            }

            let map_offset = current_offset;
            let (map_payload, map_crc, length_bits, self_bits, parent_bits, first_offset) =
                Self::encode_v5_compressed_map(&entries)?;
            let map_bytes = u32::try_from(map_payload.len()).map_err(|_| {
                RomWeaverError::Validation("compressed CHD map exceeded u32 size".to_string())
            })?;
            let mut map_header = [0_u8; 16];
            map_header[..4].copy_from_slice(&map_bytes.to_be_bytes());
            Self::write_u48_be(&mut map_header[4..10], first_offset)?;
            map_header[10..12].copy_from_slice(&map_crc.to_be_bytes());
            map_header[12] = length_bits;
            map_header[13] = self_bits;
            map_header[14] = parent_bits;
            map_header[15] = 0;
            output_file.write_all(&map_header).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to write CHD map header to `{}`: {error}",
                    output.display()
                ))
            })?;
            output_file.write_all(&map_payload).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to write CHD map payload to `{}`: {error}",
                    output.display()
                ))
            })?;

            self.patch_chd_header_u64(
                &mut output_file,
                output,
                Self::CHD_V5_HEADER_MAP_OFFSET,
                map_offset,
                "map",
            )?;
            let metadata_entries = self.rust_metadata_entries(create_kind)?;
            if let Some(meta_offset) =
                self.append_rust_metadata(&mut output_file, output, &metadata_entries)?
            {
                self.patch_chd_header_u64(
                    &mut output_file,
                    output,
                    Self::CHD_V5_HEADER_META_OFFSET,
                    meta_offset,
                    "metadata",
                )?;
            }
            self.patch_chd_header_sha1s(
                &mut output_file,
                output,
                input,
                logical_bytes,
                &metadata_entries,
            )?;
            output_file.flush().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to flush `{}`: {error}",
                    output.display()
                ))
            })?;

            Ok(ChdHeader {
                version: 5,
                logical_bytes,
                hunk_bytes,
                hunk_count,
                unit_bytes,
                unit_count: logical_bytes.div_ceil(u64::from(unit_bytes)),
                compressed: true,
                compression: codecs,
            })
        }

        fn build_chd_v5_header(
            &self,
            logical_bytes: u64,
            map_offset: u64,
            hunk_bytes: u32,
            unit_bytes: u32,
            codecs: [ChdCodec; CHD_MAX_COMPRESSORS],
            parent_sha1: Option<[u8; Self::CHD_SHA1_BYTES]>,
        ) -> [u8; Self::CHD_V5_HEADER_BYTES as usize] {
            let mut header = [0_u8; Self::CHD_V5_HEADER_BYTES as usize];
            header[0..8].copy_from_slice(&CHD_SIGNATURE);
            header[8..12].copy_from_slice(&(Self::CHD_V5_HEADER_BYTES as u32).to_be_bytes());
            header[12..16].copy_from_slice(&5_u32.to_be_bytes());
            header[16..20].copy_from_slice(&codecs[0].raw().to_be_bytes());
            header[20..24].copy_from_slice(&codecs[1].raw().to_be_bytes());
            header[24..28].copy_from_slice(&codecs[2].raw().to_be_bytes());
            header[28..32].copy_from_slice(&codecs[3].raw().to_be_bytes());
            header[32..40].copy_from_slice(&logical_bytes.to_be_bytes());
            header[40..48].copy_from_slice(&map_offset.to_be_bytes());
            header[48..56].copy_from_slice(&0_u64.to_be_bytes());
            header[56..60].copy_from_slice(&hunk_bytes.to_be_bytes());
            header[60..64].copy_from_slice(&unit_bytes.to_be_bytes());
            if let Some(parent_sha1) = parent_sha1 {
                header[Self::CHD_V5_HEADER_PARENT_SHA1_OFFSET as usize
                    ..Self::CHD_V5_HEADER_PARENT_SHA1_OFFSET as usize + Self::CHD_SHA1_BYTES]
                    .copy_from_slice(&parent_sha1);
            }
            header
        }

        fn pcm_i16_interleaved_to_samples(
            &self,
            pcm_bytes: &[u8],
            byte_order: FlacSampleByteOrder,
        ) -> Result<Vec<i32>> {
            if pcm_bytes.len() % (Self::FLAC_CHANNELS * 2) != 0 {
                return Err(RomWeaverError::Validation(format!(
                    "flac encode expects stereo 16-bit interleaved PCM bytes (len={} is not divisible by {})",
                    pcm_bytes.len(),
                    Self::FLAC_CHANNELS * 2
                )));
            }
            let mut samples = Vec::with_capacity(pcm_bytes.len() / 2);
            for chunk in pcm_bytes.chunks_exact(2) {
                let value = match byte_order {
                    FlacSampleByteOrder::LittleEndian => i16::from_le_bytes([chunk[0], chunk[1]]),
                    FlacSampleByteOrder::BigEndian => i16::from_be_bytes([chunk[0], chunk[1]]),
                };
                samples.push(i32::from(value));
            }
            Ok(samples)
        }

        fn encode_flac_frame_stream(
            &self,
            pcm_bytes: &[u8],
            byte_order: FlacSampleByteOrder,
        ) -> Result<Vec<u8>> {
            let samples = self.pcm_i16_interleaved_to_samples(pcm_bytes, byte_order)?;
            let samples_per_channel = samples.len() / Self::FLAC_CHANNELS;
            if samples_per_channel < 32 {
                return Err(RomWeaverError::Validation(format!(
                    "flac encode requires at least 32 samples per channel; received {samples_per_channel}"
                )));
            }
            let block_size = samples_per_channel.min(32_767);
            let config = flacenc::config::Encoder::default()
                .into_verified()
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "invalid flac encoder configuration: {error:?}"
                    ))
                })?;
            let source = flacenc::source::MemSource::from_samples(
                &samples,
                Self::FLAC_CHANNELS,
                Self::FLAC_BITS_PER_SAMPLE,
                Self::FLAC_SAMPLE_RATE_HZ,
            );
            let stream = flacenc::encode_with_fixed_block_size(&config, source, block_size)
                .map_err(|error| {
                    RomWeaverError::Validation(format!("flac compression failed: {error}"))
                })?;
            let mut sink = flacenc::bitsink::ByteSink::new();
            for frame_index in 0..stream.frame_count() {
                let frame = stream.frame(frame_index).ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "missing flac frame {frame_index} during serialization"
                    ))
                })?;
                frame.write(&mut sink).map_err(|error| {
                    RomWeaverError::Validation(format!("flac frame serialization failed: {error}"))
                })?;
            }
            Ok(sink.as_slice().to_vec())
        }

        fn encode_huffman_identity_payload(&self, hunk: &[u8]) -> Vec<u8> {
            let mut writer = MsbBitWriter::new();
            for length_bits in Self::HUFFMAN_SMALL_TREE_BITS {
                writer.write_bits(u64::from(length_bits), 3);
            }
            // The main tree uses 8-bit canonical lengths for all 256 symbols:
            // token stream: [9, 0] where 0 repeats the previous length 255 times.
            writer.write_bits(1, 1);
            writer.write_bits(0, 1);
            writer.write_bits(7, 3);
            writer.write_bits(246, 8);
            for &byte in hunk {
                writer.write_bits(u64::from(byte), 8);
            }
            writer.finish()
        }

        fn canonical_codes_from_lengths(&self, lengths: &[u8]) -> Result<Vec<Option<(u32, u8)>>> {
            let mut histogram = [0_u32; 33];
            for &length in lengths {
                if usize::from(length) >= histogram.len() {
                    return Err(RomWeaverError::Validation(format!(
                        "unsupported huffman bit length {}",
                        length
                    )));
                }
                histogram[length as usize] = histogram[length as usize].saturating_add(1);
            }

            let mut curr_start = 0_u32;
            for code_len in (1..histogram.len()).rev() {
                let next_start = (curr_start + histogram[code_len]) >> 1;
                if code_len != 1 && next_start.saturating_mul(2) != curr_start + histogram[code_len]
                {
                    return Err(RomWeaverError::Validation(
                        "invalid huffman length distribution".to_string(),
                    ));
                }
                histogram[code_len] = curr_start;
                curr_start = next_start;
            }

            let mut codes = vec![None; lengths.len()];
            for (index, &length) in lengths.iter().enumerate() {
                if length == 0 {
                    continue;
                }
                let start = &mut histogram[length as usize];
                codes[index] = Some((*start, length));
                *start = start.saturating_add(1);
            }
            Ok(codes)
        }

        fn write_huffman_tree_rle_lengths(
            &self,
            writer: &mut MsbBitWriter,
            lengths: &[u8],
            rle_bits: u8,
        ) -> Result<()> {
            if rle_bits == 0 || rle_bits > 8 {
                return Err(RomWeaverError::Validation(
                    "invalid avhuff tree configuration".to_string(),
                ));
            }
            let max_symbol_value = (1_u16 << rle_bits) - 1;
            let max_run_len = usize::from(max_symbol_value).saturating_add(3);

            let mut index = 0usize;
            while index < lengths.len() {
                let value = lengths[index];
                if u16::from(value) > max_symbol_value {
                    return Err(RomWeaverError::Validation(format!(
                        "avhuff tree symbol `{value}` exceeds {rle_bits}-bit range"
                    )));
                }

                let mut run_len = 1usize;
                while index + run_len < lengths.len() && lengths[index + run_len] == value {
                    run_len += 1;
                }

                if value != 1 && run_len >= 3 {
                    let mut remaining = run_len;
                    while remaining >= 3 {
                        let this_run = remaining.min(max_run_len);
                        if this_run < 3 {
                            break;
                        }
                        writer.write_bits(1, rle_bits);
                        writer.write_bits(u64::from(value), rle_bits);
                        writer.write_bits(u64::try_from(this_run - 3).unwrap_or(0), rle_bits);
                        remaining -= this_run;
                    }
                    for _ in 0..remaining {
                        writer.write_bits(u64::from(value), rle_bits);
                    }
                } else if value == 1 {
                    for _ in 0..run_len {
                        writer.write_bits(1, rle_bits);
                        writer.write_bits(1, rle_bits);
                    }
                } else {
                    for _ in 0..run_len {
                        writer.write_bits(u64::from(value), rle_bits);
                    }
                }

                index += run_len;
            }
            Ok(())
        }

        fn encode_avhuff_video_payload(
            &self,
            width: u16,
            height: u16,
            video: &[u8],
        ) -> Result<Vec<u8>> {
            if width == 0 || height == 0 {
                return Ok(vec![0x80]);
            }
            if width % 2 != 0 {
                return Err(RomWeaverError::Validation(format!(
                    "avhuff encode expects even frame width; received {width}"
                )));
            }

            let expected_video_bytes = usize::from(width)
                .saturating_mul(usize::from(height))
                .saturating_mul(2);
            if video.len() != expected_video_bytes {
                return Err(RomWeaverError::Validation(format!(
                    "avhuff frame video payload length mismatch (expected {expected_video_bytes}, found {})",
                    video.len()
                )));
            }

            let mut delta_tree_lengths = vec![9_u8; Self::AVHUFF_DELTA_TREE_SYMBOLS];
            for length in delta_tree_lengths
                .iter_mut()
                .take(Self::AVHUFF_DELTA_TREE_8BIT_COUNT)
            {
                *length = 8;
            }
            let delta_tree_codes = self.canonical_codes_from_lengths(&delta_tree_lengths)?;

            let mut writer = MsbBitWriter::new();
            writer.write_bits(0x80, 8);
            for _ in 0..3 {
                self.write_huffman_tree_rle_lengths(
                    &mut writer,
                    &delta_tree_lengths,
                    Self::AVHUFF_DELTA_TREE_BITS,
                )?;
                writer.align_to_byte();
            }

            let mut prev_y = 0_u8;
            let mut prev_cb = 0_u8;
            let mut prev_cr = 0_u8;
            let stride = usize::from(width) * 2;
            for row in 0..usize::from(height) {
                let row_start = row.saturating_mul(stride);
                let row_bytes = &video[row_start..row_start + stride];
                for pair in row_bytes.chunks_exact(4) {
                    let y0 = pair[0];
                    let cb = pair[1];
                    let y1 = pair[2];
                    let cr = pair[3];

                    let dy0 = y0.wrapping_sub(prev_y);
                    prev_y = y0;
                    let (bits, bit_count) =
                        delta_tree_codes[usize::from(dy0)].ok_or_else(|| {
                            RomWeaverError::Validation("missing avhuff delta code".to_string())
                        })?;
                    writer.write_bits(u64::from(bits), bit_count);

                    let dcb = cb.wrapping_sub(prev_cb);
                    prev_cb = cb;
                    let (bits, bit_count) =
                        delta_tree_codes[usize::from(dcb)].ok_or_else(|| {
                            RomWeaverError::Validation("missing avhuff delta code".to_string())
                        })?;
                    writer.write_bits(u64::from(bits), bit_count);

                    let dy1 = y1.wrapping_sub(prev_y);
                    prev_y = y1;
                    let (bits, bit_count) =
                        delta_tree_codes[usize::from(dy1)].ok_or_else(|| {
                            RomWeaverError::Validation("missing avhuff delta code".to_string())
                        })?;
                    writer.write_bits(u64::from(bits), bit_count);

                    let dcr = cr.wrapping_sub(prev_cr);
                    prev_cr = cr;
                    let (bits, bit_count) =
                        delta_tree_codes[usize::from(dcr)].ok_or_else(|| {
                            RomWeaverError::Validation("missing avhuff delta code".to_string())
                        })?;
                    writer.write_bits(u64::from(bits), bit_count);
                }
            }
            writer.align_to_byte();
            Ok(writer.finish())
        }

        fn encode_avhuff_chav_hunk(&self, hunk: &[u8]) -> Result<Vec<u8>> {
            if hunk.len() < 12 || &hunk[..4] != b"chav" {
                return Err(RomWeaverError::Validation(
                    "avhuff encode expects a raw `chav` frame payload".to_string(),
                ));
            }

            let metadata_size = usize::from(hunk[4]);
            let channels = usize::from(hunk[5]);
            let samples = usize::from(u16::from_be_bytes([hunk[6], hunk[7]]));
            let width = u16::from_be_bytes([hunk[8], hunk[9]]);
            let height = u16::from_be_bytes([hunk[10], hunk[11]]);

            let audio_bytes = channels.saturating_mul(samples).saturating_mul(2);
            let video_bytes = usize::from(width)
                .saturating_mul(usize::from(height))
                .saturating_mul(2);
            let expected_len = 12usize
                .saturating_add(metadata_size)
                .saturating_add(audio_bytes)
                .saturating_add(video_bytes);
            if hunk.len() != expected_len {
                return Err(RomWeaverError::Validation(format!(
                    "avhuff encode expected {expected_len} bytes from chav frame header, found {}",
                    hunk.len()
                )));
            }

            if samples.saturating_mul(2) > usize::from(u16::MAX) {
                return Err(RomWeaverError::Unsupported(
                    "avhuff encode currently supports up to 32767 audio samples per channel"
                        .to_string(),
                ));
            }

            let metadata_start = 12;
            let metadata_end = metadata_start + metadata_size;
            let audio_end = metadata_end + audio_bytes;
            let metadata = &hunk[metadata_start..metadata_end];
            let audio = &hunk[metadata_end..audio_end];
            let video = &hunk[audio_end..];

            let mut encoded_audio = Vec::with_capacity(audio_bytes);
            let channel_bytes = samples.saturating_mul(2);
            for channel_index in 0..channels {
                let channel_start = channel_index.saturating_mul(channel_bytes);
                let channel_end = channel_start + channel_bytes;
                let channel_samples = &audio[channel_start..channel_end];
                let mut prev_sample = 0_u16;
                for sample_bytes in channel_samples.chunks_exact(2) {
                    let sample = u16::from_be_bytes([sample_bytes[0], sample_bytes[1]]);
                    let delta = sample.wrapping_sub(prev_sample);
                    prev_sample = sample;
                    encoded_audio.extend_from_slice(&delta.to_be_bytes());
                }
            }
            let encoded_video = self.encode_avhuff_video_payload(width, height, video)?;

            let mut encoded = Vec::with_capacity(
                10usize
                    .saturating_add(channels.saturating_mul(2))
                    .saturating_add(metadata_size)
                    .saturating_add(encoded_audio.len())
                    .saturating_add(encoded_video.len()),
            );
            encoded.push(hunk[4]);
            encoded.push(hunk[5]);
            encoded.extend_from_slice(&hunk[6..8]);
            encoded.extend_from_slice(&hunk[8..10]);
            encoded.extend_from_slice(&hunk[10..12]);
            // Tree size of 0 indicates uncompressed audio deltas.
            encoded.extend_from_slice(&0_u16.to_be_bytes());
            for _ in 0..channels {
                encoded.extend_from_slice(
                    &u16::try_from(channel_bytes)
                        .map_err(|_| {
                            RomWeaverError::Validation(
                                "avhuff channel payload length overflow".to_string(),
                            )
                        })?
                        .to_be_bytes(),
                );
            }
            encoded.extend_from_slice(metadata);
            encoded.extend_from_slice(&encoded_audio);
            encoded.extend_from_slice(&encoded_video);
            Ok(encoded)
        }

        fn compress_rust_hunk(
            &self,
            create_kind: &ChdCreateKind,
            primary_codec: ChdCodec,
            compression_level: i32,
            hunk: &[u8],
        ) -> Result<Vec<u8>> {
            if matches!(create_kind, ChdCreateKind::Disc(_)) {
                return self.compress_rust_cd_hunk(primary_codec, compression_level, hunk);
            }
            match primary_codec {
                ChdCodec::ZSTD => zstd_compress(hunk, compression_level).map_err(|error| {
                    RomWeaverError::Validation(format!("zstd compression failed: {error}"))
                }),
                ChdCodec::ZLIB => {
                    let compression = if compression_level <= 0 {
                        GzipCompression::default()
                    } else {
                        GzipCompression::new(compression_level.clamp(1, 9) as u32)
                    };
                    let mut encoder = DeflateEncoder::new(Vec::new(), compression);
                    encoder.write_all(hunk).map_err(|error| {
                        RomWeaverError::Validation(format!("zlib compression failed: {error}"))
                    })?;
                    encoder.finish().map_err(|error| {
                        RomWeaverError::Validation(format!("zlib compression failed: {error}"))
                    })
                }
                ChdCodec::LZMA => {
                    let lzma_level = if compression_level <= 0 {
                        9
                    } else {
                        compression_level as u32
                    }
                    .min(9);
                    let mut options = LzmaOptions::with_preset(lzma_level);
                    options.lc = 3;
                    options.lp = 0;
                    options.pb = 2;
                    options.dict_size = Self::chd_lzma_dict_size(lzma_level, hunk.len() as u32);
                    let mut compressed = Vec::new();
                    let mut writer = LzmaWriter::new_no_header(&mut compressed, &options, false)
                        .map_err(|error| {
                            RomWeaverError::Validation(format!("lzma compression failed: {error}"))
                        })?;
                    writer.write_all(hunk).map_err(|error| {
                        RomWeaverError::Validation(format!("lzma compression failed: {error}"))
                    })?;
                    writer.finish().map_err(|error| {
                        RomWeaverError::Validation(format!("lzma compression failed: {error}"))
                    })?;
                    Ok(compressed)
                }
                ChdCodec::HUFFMAN => Ok(self.encode_huffman_identity_payload(hunk)),
                ChdCodec::AVHUFF => match create_kind {
                    ChdCreateKind::Av(_) => self.encode_avhuff_chav_hunk(hunk),
                    _ => Err(RomWeaverError::Unsupported(
                        "rust chd compressed create supports `avhuff` only for `chav` frame inputs"
                            .to_string(),
                    )),
                },
                ChdCodec::FLAC => {
                    let mut encoded = Vec::new();
                    encoded.push(b'L');
                    encoded.extend(
                        self.encode_flac_frame_stream(hunk, FlacSampleByteOrder::LittleEndian)?,
                    );
                    Ok(encoded)
                }
                other => Err(RomWeaverError::Unsupported(format!(
                    "rust chd compressed create does not support codec `{}` for this media mode",
                    self.codec_label(other)
                ))),
            }
        }

        fn compress_rust_cd_hunk(
            &self,
            primary_codec: ChdCodec,
            compression_level: i32,
            hunk: &[u8],
        ) -> Result<Vec<u8>> {
            let frame_bytes = usize::try_from(Self::CD_FRAME_BYTES).map_err(|_| {
                RomWeaverError::Validation("invalid CD frame size for rust CHD encoder".to_string())
            })?;
            if frame_bytes != Self::CD_SECTOR_DATA_BYTES + Self::CD_SUBCODE_BYTES {
                return Err(RomWeaverError::Validation(
                    "unexpected CD frame layout for rust CHD encoder".to_string(),
                ));
            }
            if hunk.len() % frame_bytes != 0 {
                return Err(RomWeaverError::Validation(
                    "cd hunk size must be a multiple of frame size".to_string(),
                ));
            }

            let frame_count = hunk.len() / frame_bytes;
            let mut sectors = Vec::with_capacity(frame_count * Self::CD_SECTOR_DATA_BYTES);
            let mut subcode = Vec::with_capacity(frame_count * Self::CD_SUBCODE_BYTES);
            for frame in hunk.chunks_exact(frame_bytes) {
                sectors.extend_from_slice(&frame[..Self::CD_SECTOR_DATA_BYTES]);
                subcode.extend_from_slice(
                    &frame[Self::CD_SECTOR_DATA_BYTES
                        ..Self::CD_SECTOR_DATA_BYTES + Self::CD_SUBCODE_BYTES],
                );
            }

            let sector_stream = match primary_codec {
                ChdCodec::CD_ZSTD => {
                    zstd_compress(&sectors, compression_level).map_err(|error| {
                        RomWeaverError::Validation(format!("cd zstd compression failed: {error}"))
                    })?
                }
                ChdCodec::CD_ZLIB => {
                    let compression = if compression_level <= 0 {
                        GzipCompression::default()
                    } else {
                        GzipCompression::new(compression_level.clamp(1, 9) as u32)
                    };
                    let mut encoder = DeflateEncoder::new(Vec::new(), compression);
                    encoder.write_all(&sectors).map_err(|error| {
                        RomWeaverError::Validation(format!("cd zlib compression failed: {error}"))
                    })?;
                    encoder.finish().map_err(|error| {
                        RomWeaverError::Validation(format!("cd zlib compression failed: {error}"))
                    })?
                }
                ChdCodec::CD_LZMA => {
                    let lzma_level = if compression_level <= 0 {
                        9
                    } else {
                        compression_level as u32
                    }
                    .min(9);
                    let mut options = LzmaOptions::with_preset(lzma_level);
                    options.lc = 3;
                    options.lp = 0;
                    options.pb = 2;
                    options.dict_size = Self::chd_lzma_dict_size(lzma_level, sectors.len() as u32);
                    let mut compressed = Vec::new();
                    let mut writer = LzmaWriter::new_no_header(&mut compressed, &options, false)
                        .map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "cd lzma compression failed: {error}"
                            ))
                        })?;
                    writer.write_all(&sectors).map_err(|error| {
                        RomWeaverError::Validation(format!("cd lzma compression failed: {error}"))
                    })?;
                    writer.finish().map_err(|error| {
                        RomWeaverError::Validation(format!("cd lzma compression failed: {error}"))
                    })?;
                    compressed
                }
                ChdCodec::CD_FLAC => {
                    self.encode_flac_frame_stream(&sectors, FlacSampleByteOrder::BigEndian)?
                }
                other => {
                    return Err(RomWeaverError::Unsupported(format!(
                        "rust chd compressed create does not support codec `{}` for disc media",
                        self.codec_label(other)
                    )));
                }
            };

            let subcode_stream = match primary_codec {
                ChdCodec::CD_ZSTD => {
                    zstd_compress(&subcode, compression_level).map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "cd subcode zstd compression failed: {error}"
                        ))
                    })?
                }
                ChdCodec::CD_ZLIB | ChdCodec::CD_LZMA | ChdCodec::CD_FLAC => {
                    let mut encoder = DeflateEncoder::new(Vec::new(), GzipCompression::default());
                    encoder.write_all(&subcode).map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "cd subcode zlib compression failed: {error}"
                        ))
                    })?;
                    encoder.finish().map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "cd subcode zlib compression failed: {error}"
                        ))
                    })?
                }
                _ => Vec::new(),
            };

            if primary_codec == ChdCodec::CD_FLAC {
                // cdfl stores frame FLAC stream directly, followed by deflate-compressed subcode.
                let mut output = Vec::with_capacity(sector_stream.len() + subcode_stream.len());
                output.extend_from_slice(&sector_stream);
                output.extend_from_slice(&subcode_stream);
                return Ok(output);
            }

            let sector_len_u32 = u32::try_from(sector_stream.len()).map_err(|_| {
                RomWeaverError::Validation("cd sector stream size exceeded u32".to_string())
            })?;
            let ecc_bytes = frame_count.div_ceil(8);
            let comp_len_bytes = if hunk.len() < 65_536 { 2 } else { 3 };
            let mut output = Vec::with_capacity(
                ecc_bytes + comp_len_bytes + sector_stream.len() + subcode_stream.len(),
            );
            output.resize(ecc_bytes + comp_len_bytes, 0);
            if comp_len_bytes == 2 {
                if sector_len_u32 > 0xFFFF {
                    return Err(RomWeaverError::Validation(
                        "cd sector stream too large for short header length".to_string(),
                    ));
                }
                output[ecc_bytes] = ((sector_len_u32 >> 8) & 0xFF) as u8;
                output[ecc_bytes + 1] = (sector_len_u32 & 0xFF) as u8;
            } else {
                if sector_len_u32 > 0x00FF_FFFF {
                    return Err(RomWeaverError::Validation(
                        "cd sector stream too large for extended header length".to_string(),
                    ));
                }
                output[ecc_bytes] = ((sector_len_u32 >> 16) & 0xFF) as u8;
                output[ecc_bytes + 1] = ((sector_len_u32 >> 8) & 0xFF) as u8;
                output[ecc_bytes + 2] = (sector_len_u32 & 0xFF) as u8;
            }
            output.extend_from_slice(&sector_stream);
            output.extend_from_slice(&subcode_stream);
            Ok(output)
        }

        fn chd_lzma_dict_size(level: u32, reduce_size: u32) -> u32 {
            let mut dict_size = if level <= 5 {
                1 << (level * 2 + 14)
            } else if level <= 7 {
                1 << 25
            } else {
                1 << 26
            };

            if dict_size > reduce_size {
                for i in 11..=30 {
                    if reduce_size <= (2_u32 << i) {
                        dict_size = 2_u32 << i;
                        break;
                    }
                    if reduce_size <= (3_u32 << i) {
                        dict_size = 3_u32 << i;
                        break;
                    }
                }
            }
            dict_size
        }

        fn encode_v5_compressed_map(
            entries: &[RustCompressedHunkEntry],
        ) -> Result<(Vec<u8>, u16, u8, u8, u8, u64)> {
            let mut raw_map = vec![0_u8; entries.len().saturating_mul(12)];
            for (index, entry) in entries.iter().enumerate() {
                let offset = index.saturating_mul(12);
                raw_map[offset] = entry.compression_type;
                Self::write_u24_be(&mut raw_map[offset + 1..offset + 4], entry.length)?;
                Self::write_u48_be(&mut raw_map[offset + 4..offset + 10], entry.offset)?;
                raw_map[offset + 10..offset + 12].copy_from_slice(&entry.crc16.to_be_bytes());
            }
            let map_crc = Self::crc16_ibm3740(&raw_map);
            let length_bits = Self::bits_for_value(
                entries
                    .iter()
                    .map(|entry| entry.length)
                    .max()
                    .unwrap_or_default(),
            );
            let mut max_self = 0_u64;
            let mut max_parent = 0_u64;
            let mut first_offset = 0_u64;
            for entry in entries {
                match entry.compression_type {
                    0..=Self::CHD_V5_MAP_TYPE_UNCOMPRESSED => {
                        if first_offset == 0 {
                            first_offset = entry.offset;
                        }
                    }
                    Self::CHD_V5_MAP_TYPE_SELF => {
                        max_self = max_self.max(entry.offset);
                    }
                    Self::CHD_V5_MAP_TYPE_PARENT => {
                        max_parent = max_parent.max(entry.offset);
                    }
                    _ => {}
                }
            }
            let self_bits = if max_self == 0 {
                0
            } else {
                (u64::BITS - max_self.leading_zeros()) as u8
            };
            let parent_bits = if max_parent == 0 {
                0
            } else {
                (u64::BITS - max_parent.leading_zeros()) as u8
            };
            let max_compression_type = entries
                .iter()
                .map(|entry| entry.compression_type)
                .max()
                .unwrap_or(0);
            if max_compression_type > Self::CHD_V5_MAP_TYPE_MAX {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported compressed CHD map type {} for rust map encoder",
                    max_compression_type
                )));
            }
            let symbol_bit_lengths =
                Self::map_symbol_bit_lengths_for_max_type(max_compression_type)?;
            let symbol_codes = Self::canonical_huffman_codes(&symbol_bit_lengths)?;

            let mut bit_writer = MsbBitWriter::new();
            Self::write_map_symbol_tree_rle(&mut bit_writer, &symbol_bit_lengths)?;

            for entry in entries {
                let (bits, bit_count) = symbol_codes[usize::from(entry.compression_type)]
                    .ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "missing map huffman code for compression type {}",
                            entry.compression_type
                        ))
                    })?;
                bit_writer.write_bits(u64::from(bits), bit_count);
            }

            for entry in entries {
                match entry.compression_type {
                    0..=Self::CHD_V5_MAP_TYPE_COMPRESSED_MAX => {
                        bit_writer.write_bits(u64::from(entry.length), length_bits);
                        bit_writer.write_bits(u64::from(entry.crc16), 16);
                    }
                    Self::CHD_V5_MAP_TYPE_UNCOMPRESSED => {
                        bit_writer.write_bits(u64::from(entry.crc16), 16);
                    }
                    Self::CHD_V5_MAP_TYPE_SELF => {
                        bit_writer.write_bits(entry.offset, self_bits);
                    }
                    Self::CHD_V5_MAP_TYPE_PARENT => {
                        bit_writer.write_bits(entry.offset, parent_bits);
                    }
                    other => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported compressed CHD map type {} for rust map encoder",
                            other
                        )));
                    }
                }
            }
            Ok((
                bit_writer.finish(),
                map_crc,
                length_bits,
                self_bits,
                parent_bits,
                first_offset,
            ))
        }

        fn map_symbol_bit_lengths_for_max_type(max_type: u8) -> Result<[u8; 16]> {
            let mut lengths = [0_u8; 16];
            match max_type {
                0 => {
                    lengths[0] = 1;
                }
                1 => {
                    lengths[0] = 1;
                    lengths[1] = 1;
                }
                2 => {
                    lengths[0] = 1;
                    lengths[1] = 2;
                    lengths[2] = 2;
                }
                3 => {
                    lengths[0] = 2;
                    lengths[1] = 2;
                    lengths[2] = 2;
                    lengths[3] = 2;
                }
                4 => {
                    lengths[0] = 2;
                    lengths[1] = 2;
                    lengths[2] = 2;
                    lengths[3] = 3;
                    lengths[4] = 3;
                }
                5 | 6 => {
                    lengths[0..8].fill(3);
                }
                _ => {
                    return Err(RomWeaverError::Validation(format!(
                        "unsupported compressed CHD map type {max_type} for rust map encoder"
                    )));
                }
            }
            Ok(lengths)
        }

        fn canonical_huffman_codes(lengths: &[u8; 16]) -> Result<[Option<(u32, u8)>; 16]> {
            let mut histogram = [0_u32; 33];
            for &length in lengths {
                if usize::from(length) >= histogram.len() {
                    return Err(RomWeaverError::Validation(format!(
                        "unsupported CHD map huffman bit length {}",
                        length
                    )));
                }
                histogram[length as usize] = histogram[length as usize].saturating_add(1);
            }

            let mut curr_start = 0_u32;
            for code_len in (1..histogram.len()).rev() {
                let next_start = (curr_start + histogram[code_len]) >> 1;
                if code_len != 1 && next_start.saturating_mul(2) != curr_start + histogram[code_len]
                {
                    return Err(RomWeaverError::Validation(
                        "invalid CHD map huffman length distribution".to_string(),
                    ));
                }
                histogram[code_len] = curr_start;
                curr_start = next_start;
            }

            let mut codes = [None; 16];
            for (index, &length) in lengths.iter().enumerate() {
                if length == 0 {
                    continue;
                }
                let start = &mut histogram[length as usize];
                codes[index] = Some((*start, length));
                *start = start.saturating_add(1);
            }
            Ok(codes)
        }

        fn write_map_symbol_tree_rle(
            bit_writer: &mut MsbBitWriter,
            lengths: &[u8; 16],
        ) -> Result<()> {
            let mut index = 0usize;
            while index < lengths.len() {
                let value = lengths[index];
                let mut run_len = 1usize;
                while index + run_len < lengths.len()
                    && lengths[index + run_len] == value
                    && run_len < 18
                {
                    run_len += 1;
                }

                if value != 1 && run_len >= 3 {
                    bit_writer.write_bits(1, 4);
                    bit_writer.write_bits(u64::from(value), 4);
                    bit_writer.write_bits(u64::try_from(run_len - 3).unwrap_or(0), 4);
                    index += run_len;
                    continue;
                }

                for _ in 0..run_len {
                    if value == 1 {
                        bit_writer.write_bits(1, 4);
                        bit_writer.write_bits(1, 4);
                    } else {
                        bit_writer.write_bits(u64::from(value), 4);
                    }
                }
                index += run_len;
            }
            Ok(())
        }

        fn write_u24_be(dst: &mut [u8], value: u32) -> Result<()> {
            if dst.len() < 3 {
                return Err(RomWeaverError::Validation(
                    "internal CHD map write buffer underflow".into(),
                ));
            }
            if value > 0x00FF_FFFF {
                return Err(RomWeaverError::Validation(format!(
                    "value {value} exceeds u24 range"
                )));
            }
            dst[0] = ((value >> 16) & 0xFF) as u8;
            dst[1] = ((value >> 8) & 0xFF) as u8;
            dst[2] = (value & 0xFF) as u8;
            Ok(())
        }

        fn write_u48_be(dst: &mut [u8], value: u64) -> Result<()> {
            if dst.len() < 6 {
                return Err(RomWeaverError::Validation(
                    "internal CHD map write buffer underflow".into(),
                ));
            }
            if value > 0x0000_FFFF_FFFF_FFFF {
                return Err(RomWeaverError::Validation(format!(
                    "value {value} exceeds u48 range"
                )));
            }
            dst[0] = ((value >> 40) & 0xFF) as u8;
            dst[1] = ((value >> 32) & 0xFF) as u8;
            dst[2] = ((value >> 24) & 0xFF) as u8;
            dst[3] = ((value >> 16) & 0xFF) as u8;
            dst[4] = ((value >> 8) & 0xFF) as u8;
            dst[5] = (value & 0xFF) as u8;
            Ok(())
        }

        fn bits_for_value(value: u32) -> u8 {
            if value == 0 {
                0
            } else {
                (u32::BITS - value.leading_zeros()) as u8
            }
        }

        fn crc16_ibm3740(bytes: &[u8]) -> u16 {
            let mut crc = 0xFFFFu16;
            for &byte in bytes {
                crc ^= u16::from(byte) << 8;
                for _ in 0..8 {
                    if (crc & 0x8000) != 0 {
                        crc = (crc << 1) ^ 0x1021;
                    } else {
                        crc <<= 1;
                    }
                }
            }
            crc
        }

        fn rust_metadata_entries(
            &self,
            create_kind: &ChdCreateKind,
        ) -> Result<Vec<RustMetadataEntry>> {
            match create_kind {
                ChdCreateKind::Raw => Ok(Vec::new()),
                ChdCreateKind::Dvd => Ok(vec![RustMetadataEntry {
                    tag: DVD_METADATA_TAG,
                    flags: CHD_METADATA_FLAG_CHECKSUM,
                    data: vec![0],
                }]),
                ChdCreateKind::HardDisk(geometry) => {
                    let mut metadata = format!(
                        "CYLS:{},HEADS:{},SECS:{},BPS:{}",
                        geometry.cylinders,
                        geometry.heads,
                        geometry.sectors,
                        geometry.bytes_per_sector
                    )
                    .into_bytes();
                    metadata.push(0);
                    Ok(vec![RustMetadataEntry {
                        tag: HARD_DISK_METADATA_TAG,
                        flags: CHD_METADATA_FLAG_CHECKSUM,
                        data: metadata,
                    }])
                }
                ChdCreateKind::Disc(layout) => {
                    let mut entries = Vec::with_capacity(layout.tracks.len());
                    for track in &layout.tracks {
                        let pgtype = if track.pregap_has_data {
                            format!("V{}", track.mode.metadata_label())
                        } else {
                            track.mode.metadata_label().to_string()
                        };
                        let mut data = match layout.kind {
                            DiscKind::CdRom => format!(
                                "TRACK:{} TYPE:{} SUBTYPE:NONE FRAMES:{} PREGAP:{} PGTYPE:{} PGSUB:NONE POSTGAP:{}",
                                track.number,
                                track.mode.metadata_label(),
                                track.frames,
                                track.pregap_frames,
                                pgtype,
                                track.postgap_frames
                            ),
                            DiscKind::GdRom => format!(
                                "TRACK:{} TYPE:{} SUBTYPE:NONE FRAMES:{} PAD:{} PREGAP:{} PGTYPE:{} PGSUB:NONE POSTGAP:{}",
                                track.number,
                                track.mode.metadata_label(),
                                track.frames,
                                track.pad_frames,
                                track.pregap_frames,
                                pgtype,
                                track.postgap_frames
                            ),
                        }
                        .into_bytes();
                        data.push(0);
                        entries.push(RustMetadataEntry {
                            tag: layout.kind.metadata_tag(),
                            flags: CHD_METADATA_FLAG_CHECKSUM,
                            data,
                        });
                    }
                    Ok(entries)
                }
                ChdCreateKind::Av(profile) => {
                    let mut metadata = format!(
                        "FPS:{}.{:06} WIDTH:{} HEIGHT:{} INTERLACED:{} CHANNELS:{} SAMPLERATE:{}",
                        profile.fps,
                        profile.fpsfrac,
                        profile.width,
                        profile.height,
                        profile.interlaced,
                        profile.channels,
                        profile.sample_rate
                    )
                    .into_bytes();
                    metadata.push(0);
                    Ok(vec![RustMetadataEntry {
                        tag: AV_METADATA_TAG,
                        flags: CHD_METADATA_FLAG_CHECKSUM,
                        data: metadata,
                    }])
                }
            }
        }

        fn append_rust_metadata(
            &self,
            output_file: &mut File,
            output_path: &Path,
            entries: &[RustMetadataEntry],
        ) -> Result<Option<u64>> {
            if entries.is_empty() {
                return Ok(None);
            }

            let mut entry_offsets = Vec::with_capacity(entries.len());
            for entry in entries {
                if entry.data.is_empty() || entry.data.len() >= 16 * 1024 * 1024 {
                    return Err(RomWeaverError::Validation(
                        "CHD metadata entries must be 1..16MiB".to_string(),
                    ));
                }
                let offset = output_file.stream_position().map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to determine metadata offset in `{}`: {error}",
                        output_path.display()
                    ))
                })?;
                entry_offsets.push(offset);

                let mut header = [0_u8; 16];
                header[..4].copy_from_slice(&entry.tag.to_be_bytes());
                header[4] = entry.flags;
                Self::write_u24_be(
                    &mut header[5..8],
                    u32::try_from(entry.data.len()).map_err(|_| {
                        RomWeaverError::Validation("metadata length overflow".to_string())
                    })?,
                )?;
                output_file.write_all(&header).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD metadata header to `{}`: {error}",
                        output_path.display()
                    ))
                })?;
                output_file.write_all(&entry.data).map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to write CHD metadata payload to `{}`: {error}",
                        output_path.display()
                    ))
                })?;
            }

            for (index, offset) in entry_offsets.iter().enumerate() {
                let next = entry_offsets.get(index + 1).copied().unwrap_or(0);
                output_file
                    .seek(SeekFrom::Start(offset.saturating_add(8)))
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to seek CHD metadata link in `{}`: {error}",
                            output_path.display()
                        ))
                    })?;
                output_file
                    .write_all(&next.to_be_bytes())
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to write CHD metadata link in `{}`: {error}",
                            output_path.display()
                        ))
                    })?;
            }
            let end = output_file.seek(SeekFrom::End(0)).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to restore CHD output offset in `{}`: {error}",
                    output_path.display()
                ))
            })?;
            let first = entry_offsets[0];
            if end < first {
                return Err(RomWeaverError::Validation(
                    "invalid CHD metadata layout".to_string(),
                ));
            }
            Ok(Some(first))
        }

        fn patch_chd_header_sha1s(
            &self,
            output_file: &mut File,
            output_path: &Path,
            source_path: &Path,
            logical_bytes: u64,
            metadata_entries: &[RustMetadataEntry],
        ) -> Result<()> {
            let raw_sha1 = Self::sha1_file_prefix(source_path, logical_bytes)?;
            let overall_sha1 = Self::compute_overall_sha1(&raw_sha1, metadata_entries);
            self.patch_chd_header_bytes(
                output_file,
                output_path,
                Self::CHD_V5_HEADER_RAW_SHA1_OFFSET,
                &raw_sha1,
                "raw sha1",
            )?;
            self.patch_chd_header_bytes(
                output_file,
                output_path,
                Self::CHD_V5_HEADER_SHA1_OFFSET,
                &overall_sha1,
                "sha1",
            )
        }

        fn compute_overall_sha1(
            raw_sha1: &[u8; Self::CHD_SHA1_BYTES],
            metadata_entries: &[RustMetadataEntry],
        ) -> [u8; Self::CHD_SHA1_BYTES] {
            let mut metadata_hashes = metadata_entries
                .iter()
                .filter(|entry| (entry.flags & CHD_METADATA_FLAG_CHECKSUM) != 0)
                .map(|entry| {
                    let mut hash_entry = [0_u8; 4 + Self::CHD_SHA1_BYTES];
                    hash_entry[..4].copy_from_slice(&entry.tag.to_be_bytes());
                    let digest = Sha1::digest(&entry.data);
                    hash_entry[4..].copy_from_slice(&digest);
                    hash_entry
                })
                .collect::<Vec<_>>();
            metadata_hashes.sort_unstable();

            let mut overall_sha1 = Sha1::new();
            overall_sha1.update(raw_sha1);
            for hash_entry in metadata_hashes {
                overall_sha1.update(hash_entry);
            }
            let digest = overall_sha1.finalize();
            let mut out = [0_u8; Self::CHD_SHA1_BYTES];
            out.copy_from_slice(&digest);
            out
        }

        fn sha1_file_prefix(
            source_path: &Path,
            logical_bytes: u64,
        ) -> Result<[u8; Self::CHD_SHA1_BYTES]> {
            let mut reader = BufReader::new(File::open(source_path).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to open `{}` for CHD sha1: {error}",
                    source_path.display()
                ))
            })?);
            let mut sha1 = Sha1::new();
            let mut remaining = logical_bytes;
            let mut buffer = [0_u8; 64 * 1024];
            while remaining > 0 {
                let read_len =
                    usize::try_from(remaining.min(buffer.len() as u64)).map_err(|_| {
                        RomWeaverError::Validation("CHD sha1 read length overflow".to_string())
                    })?;
                reader
                    .read_exact(&mut buffer[..read_len])
                    .map_err(|error| {
                        RomWeaverError::Validation(format!(
                            "failed to read `{}` for CHD sha1: {error}",
                            source_path.display()
                        ))
                    })?;
                sha1.update(&buffer[..read_len]);
                remaining = remaining.saturating_sub(read_len as u64);
            }

            let digest = sha1.finalize();
            let mut out = [0_u8; Self::CHD_SHA1_BYTES];
            out.copy_from_slice(&digest);
            Ok(out)
        }

        fn patch_chd_header_u64(
            &self,
            output_file: &mut File,
            output_path: &Path,
            header_offset: u64,
            value: u64,
            field_label: &str,
        ) -> Result<()> {
            self.patch_chd_header_bytes(
                output_file,
                output_path,
                header_offset,
                &value.to_be_bytes(),
                field_label,
            )
        }

        fn patch_chd_header_bytes(
            &self,
            output_file: &mut File,
            output_path: &Path,
            header_offset: u64,
            bytes: &[u8],
            field_label: &str,
        ) -> Result<()> {
            let restore_offset = output_file.stream_position().map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to capture CHD write offset in `{}`: {error}",
                    output_path.display()
                ))
            })?;
            output_file
                .seek(SeekFrom::Start(header_offset))
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to seek CHD {field_label} pointer in `{}`: {error}",
                        output_path.display()
                    ))
                })?;
            output_file.write_all(bytes).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to finalize CHD {field_label} pointer in `{}`: {error}",
                    output_path.display()
                ))
            })?;
            output_file
                .seek(SeekFrom::Start(restore_offset))
                .map_err(|error| {
                    RomWeaverError::Validation(format!(
                        "failed to restore CHD write offset in `{}`: {error}",
                        output_path.display()
                    ))
                })?;
            Ok(())
        }

        fn infer_create_kind(&self, input: &Path, logical_bytes: u64) -> Result<ChdCreateKind> {
            let extension = input
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.to_ascii_lowercase());
            match extension.as_deref() {
                Some("iso") => {
                    self.ensure_multiple_of(logical_bytes, Self::DVD_SECTOR_BYTES, "dvd image")?;
                    Ok(ChdCreateKind::Dvd)
                }
                Some("img") | Some("ima") => Ok(ChdCreateKind::HardDisk(
                    self.infer_hd_geometry(logical_bytes)?,
                )),
                Some("cue") => Ok(ChdCreateKind::Disc(self.parse_cue_file(input)?)),
                Some("gdi") => Ok(ChdCreateKind::Disc(self.parse_gdi_file(input)?)),
                _ => Ok(ChdCreateKind::Raw),
            }
        }

        fn parse_create_mode_override(
            &self,
            format: &str,
        ) -> Result<Option<ChdCreateModeOverride>> {
            let normalized = format.trim().to_ascii_lowercase();
            if normalized == "chd" {
                return Ok(None);
            }

            let Some(mode) = normalized.strip_prefix("chd-") else {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported chd format `{format}`; expected `chd` or `chd-<mode>` where mode is cd|dvd|raw|hd"
                )));
            };

            match mode {
                "cd" => Ok(Some(ChdCreateModeOverride::Cd)),
                "dvd" => Ok(Some(ChdCreateModeOverride::Dvd)),
                "raw" => Ok(Some(ChdCreateModeOverride::Raw)),
                "hd" => Ok(Some(ChdCreateModeOverride::HardDisk)),
                _ => Err(RomWeaverError::Validation(format!(
                    "unsupported chd mode `{mode}` in `{format}`; expected one of: cd, dvd, raw, hd"
                ))),
            }
        }

        fn infer_create_kind_with_override(
            &self,
            input: &Path,
            logical_bytes: u64,
            mode: ChdCreateModeOverride,
        ) -> Result<ChdCreateKind> {
            match mode {
                ChdCreateModeOverride::Cd => {
                    let extension = input
                        .extension()
                        .and_then(|value| value.to_str())
                        .map(|value| value.to_ascii_lowercase());
                    let layout = match extension.as_deref() {
                        Some("cue") => self.parse_cue_file(input)?,
                        Some("gdi") => {
                            return Err(RomWeaverError::Validation(format!(
                                "chd-cd does not accept gdi input `{}`; use `chd` or `chd-raw` for gd media",
                                input.display()
                            )));
                        }
                        _ => {
                            let (mode, sector_bytes) = if logical_bytes
                                % u64::try_from(DiscTrackMode::Mode1Raw.data_bytes())
                                    .unwrap_or(2352)
                                == 0
                            {
                                (
                                    DiscTrackMode::Mode1Raw,
                                    DiscTrackMode::Mode1Raw.data_bytes(),
                                )
                            } else if logical_bytes
                                % u64::try_from(DiscTrackMode::Mode1.data_bytes()).unwrap_or(2048)
                                == 0
                            {
                                (DiscTrackMode::Mode1, DiscTrackMode::Mode1.data_bytes())
                            } else {
                                return Err(RomWeaverError::Validation(format!(
                                    "chd-cd input `{}` size must be a multiple of 2352 or 2048 bytes unless a cue file is provided",
                                    input.display()
                                )));
                            };
                            let frames = logical_bytes / u64::try_from(sector_bytes).unwrap_or(1);
                            let frames = u32::try_from(frames).map_err(|_| {
                                RomWeaverError::Validation(format!(
                                    "chd-cd input `{}` is too large for current track metadata limits",
                                    input.display()
                                ))
                            })?;
                            DiscLayout {
                                kind: DiscKind::CdRom,
                                tracks: vec![DiscTrack {
                                    number: 1,
                                    mode,
                                    file_path: input.to_path_buf(),
                                    file_offset_bytes: 0,
                                    frames,
                                    pregap_frames: 0,
                                    postgap_frames: 0,
                                    pregap_has_data: false,
                                    has_subcode: false,
                                    pad_frames: 0,
                                    swap_audio_on_read: false,
                                }],
                            }
                        }
                    };
                    if layout.kind != DiscKind::CdRom {
                        return Err(RomWeaverError::Validation(format!(
                            "chd-cd input `{}` resolved to non-cd media",
                            input.display()
                        )));
                    }
                    Ok(ChdCreateKind::Disc(layout))
                }
                ChdCreateModeOverride::Dvd => {
                    self.ensure_multiple_of(logical_bytes, Self::DVD_SECTOR_BYTES, "dvd image")?;
                    Ok(ChdCreateKind::Dvd)
                }
                ChdCreateModeOverride::Raw => Ok(ChdCreateKind::Raw),
                ChdCreateModeOverride::HardDisk => Ok(ChdCreateKind::HardDisk(
                    self.infer_hd_geometry(logical_bytes)?,
                )),
            }
        }

        #[cfg(test)]
        pub(super) fn infer_create_kind_label_for_tests(
            &self,
            format: &str,
            input: &Path,
            logical_bytes: u64,
        ) -> Result<&'static str> {
            let mode_override = self.parse_create_mode_override(format)?;
            let create_kind = if let Some(mode) = mode_override {
                self.infer_create_kind_with_override(input, logical_bytes, mode)?
            } else {
                self.infer_create_kind(input, logical_bytes)?
            };
            Ok(match create_kind {
                ChdCreateKind::Raw => "raw",
                ChdCreateKind::HardDisk(_) => "hd",
                ChdCreateKind::Dvd => "dvd",
                ChdCreateKind::Disc(layout) => match layout.kind {
                    DiscKind::CdRom => "cd",
                    DiscKind::GdRom => "gd",
                },
                ChdCreateKind::Av(_) => "av",
            })
        }

        fn unit_bytes(&self, create_kind: &ChdCreateKind) -> u32 {
            match create_kind {
                ChdCreateKind::Raw => 1,
                ChdCreateKind::HardDisk(geometry) => geometry.bytes_per_sector,
                ChdCreateKind::Dvd => Self::DVD_SECTOR_BYTES,
                ChdCreateKind::Disc(_) => Self::CD_FRAME_BYTES,
                ChdCreateKind::Av(_) => 1,
            }
        }

        fn hunk_bytes(
            &self,
            create_kind: &ChdCreateKind,
            logical_bytes: u64,
            codec: ChdCodec,
        ) -> u32 {
            match create_kind {
                ChdCreateKind::Disc(_) if codec != ChdCodec::NONE => {
                    let total_frames = logical_bytes / u64::from(Self::CD_FRAME_BYTES);
                    if total_frames <= 1 {
                        Self::CD_HUNK_BYTES
                    } else {
                        let frames_per_hunk = total_frames.div_ceil(2).min(8);
                        u32::try_from(frames_per_hunk)
                            .unwrap_or(8)
                            .saturating_mul(Self::CD_FRAME_BYTES)
                    }
                }
                ChdCreateKind::Disc(_) => Self::CD_HUNK_BYTES,
                ChdCreateKind::Av(profile) => profile.frame_bytes,
                _ => Self::DEFAULT_HUNK_BYTES,
            }
        }

        fn infer_hd_geometry(&self, logical_bytes: u64) -> Result<HdGeometry> {
            self.ensure_multiple_of(logical_bytes, Self::HD_SECTOR_BYTES, "hard-disk image")?;
            let total_sectors = logical_bytes / u64::from(Self::HD_SECTOR_BYTES);
            const CANDIDATES: &[(u32, u32)] = &[
                (255, 63),
                (240, 63),
                (128, 63),
                (64, 63),
                (32, 63),
                (16, 63),
                (16, 32),
                (16, 16),
                (8, 32),
                (8, 16),
                (4, 16),
                (2, 16),
                (1, 1),
            ];

            for &(heads, sectors) in CANDIDATES {
                let span = u64::from(heads) * u64::from(sectors);
                if span == 0 || total_sectors % span != 0 {
                    continue;
                }

                let cylinders = total_sectors / span;
                if cylinders <= u64::from(u32::MAX) {
                    return Ok(HdGeometry {
                        cylinders: cylinders as u32,
                        heads,
                        sectors,
                        bytes_per_sector: Self::HD_SECTOR_BYTES,
                    });
                }
            }

            Err(RomWeaverError::Validation(format!(
                "hard-disk image `{logical_bytes}` bytes is too large for the current synthetic geometry heuristic"
            )))
        }

        fn infer_av_profile(&self, input: &Path, logical_bytes: u64) -> Result<AvProfile> {
            let mut reader = BufReader::new(File::open(input).map_err(|error| {
                RomWeaverError::Validation(format!("failed to open `{}`: {error}", input.display()))
            })?);
            let mut header = [0_u8; 12];
            reader.read_exact(&mut header).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "failed to read A/V header from `{}`: {error}",
                    input.display()
                ))
            })?;
            if &header[..4] != b"chav" {
                return Err(RomWeaverError::Validation(format!(
                    "chd codec `avhuff` requires `chav` frames; `{}` does not start with a `chav` header",
                    input.display()
                )));
            }

            let metadata_bytes = u64::from(header[4]);
            let channels = u64::from(header[5]);
            let samples = u64::from(u16::from_be_bytes([header[6], header[7]]));
            let width = u64::from(u16::from_be_bytes([header[8], header[9]]));
            let height = u64::from(u16::from_be_bytes([header[10], header[11]]));

            let frame_bytes = 12_u64
                .saturating_add(metadata_bytes)
                .saturating_add(channels.saturating_mul(samples).saturating_mul(2))
                .saturating_add(width.saturating_mul(height).saturating_mul(2));
            let frame_bytes_u32 = u32::try_from(frame_bytes).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "A/V frame size `{frame_bytes}` in `{}` exceeds supported limits",
                    input.display()
                ))
            })?;
            if frame_bytes_u32 == 0 {
                return Err(RomWeaverError::Validation(format!(
                    "A/V frame size in `{}` resolved to zero bytes",
                    input.display()
                )));
            }
            self.ensure_multiple_of(logical_bytes, frame_bytes_u32, "av frame stream")?;

            Ok(AvProfile {
                frame_bytes: frame_bytes_u32,
                fps: 1,
                fpsfrac: 0,
                width: width as u32,
                height: height as u32,
                interlaced: 0,
                channels: channels as u32,
                sample_rate: samples as u32,
            })
        }

        fn ensure_multiple_of(
            &self,
            logical_bytes: u64,
            unit_bytes: u32,
            label: &str,
        ) -> Result<()> {
            if logical_bytes % u64::from(unit_bytes) == 0 {
                Ok(())
            } else {
                Err(RomWeaverError::Validation(format!(
                    "{label} size must be a multiple of {unit_bytes} bytes"
                )))
            }
        }
    }

    impl ContainerHandler for ChdContainerHandler {
        fn descriptor(&self) -> &'static FormatDescriptor {
            &CHD
        }

        fn probe(&self, source: &Path) -> ProbeConfidence {
            if file_starts_with(source, &CHD_SIGNATURE) {
                ProbeConfidence::Signature
            } else {
                ProbeConfidence::Extension
            }
        }

        fn inspect(
            &self,
            request: &ContainerInspectRequest,
            context: &OperationContext,
        ) -> Result<OperationReport> {
            let execution = context.plan_threads(ThreadCapability::single_threaded());
            let chd = ChdReadSession::open(&request.source, None)?;
            let header = chd.header();
            let media_kind = chd.media_kind();
            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "inspect",
                format!(
                    "{} chd v{}: {} bytes, {}-byte hunks, codec={}",
                    self.media_label(media_kind),
                    header.version,
                    header.logical_bytes,
                    header.hunk_bytes,
                    self.header_codec_label(header)
                ),
                Some(100.0),
                Some(execution),
            ))
        }

        fn list_entries(
            &self,
            request: &ContainerInspectRequest,
            _context: &OperationContext,
        ) -> Result<Vec<String>> {
            let chd = ChdReadSession::open(&request.source, None)?;
            let media_kind = chd.media_kind();
            let stem = request
                .source
                .file_stem()
                .and_then(|value| value.to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("output");
            if media_kind == ChdMediaKind::CdRom {
                let layout = self.read_disc_tracks(&chd, DiscKind::CdRom)?;
                let first_data_bytes = layout
                    .tracks
                    .first()
                    .map(|track| track.mode.data_bytes())
                    .unwrap_or(2352);
                let single_bin = layout
                    .tracks
                    .iter()
                    .all(|track| track.mode.data_bytes() == first_data_bytes);
                let mut entries = vec![format!("{stem}.cue")];
                if single_bin {
                    entries.push(format!("{stem}.bin"));
                } else {
                    for track in &layout.tracks {
                        entries.push(self.track_output_name(stem, track.number));
                    }
                }
                return Ok(entries);
            }
            if media_kind == ChdMediaKind::GdRom {
                let layout = self.read_disc_tracks(&chd, DiscKind::GdRom)?;
                let mut entries = vec![format!("{stem}.gdi")];
                for track in &layout.tracks {
                    entries.push(self.track_output_name(stem, track.number));
                }
                return Ok(entries);
            }
            Ok(vec![self.extract_name(&request.source, media_kind)?])
        }

        fn extract(
            &self,
            request: &ContainerExtractRequest,
            context: &OperationContext,
        ) -> Result<OperationReport> {
            let execution = context.plan_threads(ThreadCapability::parallel(None));
            let chd = ChdReadSession::open(&request.source, request.parent.as_deref())?;
            let media_kind = chd.media_kind();
            if request.split_bin && media_kind != ChdMediaKind::CdRom {
                return Err(RomWeaverError::Validation(format!(
                    "chd extract --split-bin is only supported for cd media; `{}` is {}",
                    request.source.display(),
                    self.media_label(media_kind)
                )));
            }
            if media_kind == ChdMediaKind::CdRom {
                return self.extract_cd(chd, request, execution);
            }
            if media_kind == ChdMediaKind::GdRom {
                return self.extract_gd(chd, request, execution);
            }
            fs::create_dir_all(&request.out_dir)?;
            let output_name = self.extract_name(&request.source, media_kind)?;
            let mut selections = SelectionMatcher::new(&request.selections);
            if !selections.matches(&output_name) {
                selections.ensure_all_matched()?;
            }
            selections.ensure_all_matched()?;
            let output_path = request.out_dir.join(&output_name);
            let header = chd.extract_to_file(&output_path, execution.effective_threads)?;
            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "extract",
                format!(
                    "extracted `{}` to `{}` ({} bytes, {}, {})",
                    request.source.display(),
                    output_path.display(),
                    header.logical_bytes,
                    self.media_label(media_kind),
                    self.header_codec_label(header)
                ),
                Some(100.0),
                Some(execution),
            ))
        }

        fn create(
            &self,
            request: &ContainerCreateRequest,
            context: &OperationContext,
        ) -> Result<OperationReport> {
            if request.inputs.len() != 1 {
                return Err(RomWeaverError::Validation(
                    "chd create currently requires exactly one input file".into(),
                ));
            }

            let execution = context.plan_threads(ThreadCapability::parallel(None));
            let input = &request.inputs[0];
            let input_bytes = fs::metadata(input)?.len();
            let mode_override = self.parse_create_mode_override(&request.format)?;
            let mut create_kind = if let Some(mode) = mode_override {
                self.infer_create_kind_with_override(input, input_bytes, mode)?
            } else {
                self.infer_create_kind(input, input_bytes)?
            };
            let mut compression_plan =
                self.resolve_compression_plan(request.codec.as_deref(), &create_kind)?;
            if compression_plan.primary_codec == ChdCodec::AVHUFF {
                create_kind = match create_kind {
                    ChdCreateKind::Raw => {
                        ChdCreateKind::Av(self.infer_av_profile(input, input_bytes)?)
                    }
                    ChdCreateKind::Av(profile) => ChdCreateKind::Av(profile),
                    _ => {
                        return Err(RomWeaverError::Validation(
                            "chd codec `avhuff` currently supports only raw `chav` frame inputs"
                                .into(),
                        ));
                    }
                };
            }
            compression_plan =
                self.resolve_compression_plan(request.codec.as_deref(), &create_kind)?;
            compression_plan =
                self.normalize_compression_plan_for_create_kind(&create_kind, compression_plan);
            let compression_level =
                self.resolve_compression_level(compression_plan.primary_codec, request.level)?;
            if let Some(parent) = request.output.parent() {
                fs::create_dir_all(parent)?;
            }

            let mut staged_input = None;
            let (source_path, logical_bytes) = match &create_kind {
                ChdCreateKind::Disc(layout) => {
                    let temp_path = self.materialize_disc_image(layout)?;
                    let logical_bytes = fs::metadata(&temp_path)?.len();
                    staged_input = Some(temp_path);
                    (
                        staged_input.as_ref().expect("staged disc input"),
                        logical_bytes,
                    )
                }
                _ => (input, input_bytes),
            };

            let rust_create = || -> Result<(ChdHeader, ChdMediaKind)> {
                let header = if compression_plan.primary_codec == ChdCodec::NONE {
                    if request.parent.is_some() {
                        return Err(RomWeaverError::Unsupported(
                            "chd create with parent requires at least one compressed codec; `store` mode cannot reference parent hunks"
                                .to_string(),
                        ));
                    }
                    self.create_uncompressed_rust_raw(
                        source_path,
                        &request.output,
                        logical_bytes,
                        &create_kind,
                    )?
                } else {
                    self.create_compressed_rust_raw(
                        source_path,
                        &request.output,
                        logical_bytes,
                        &create_kind,
                        compression_plan.codecs,
                        compression_level,
                        execution.effective_threads,
                        request.parent.as_deref(),
                    )?
                };
                Ok((header, self.media_kind_from_create_kind(&create_kind)))
            };

            let should_attempt_rust = self.should_attempt_rust_create(
                &create_kind,
                compression_plan.codecs,
                compression_plan.primary_codec,
            );
            let create_result = if !should_attempt_rust {
                Err(RomWeaverError::Unsupported(format!(
                    "chd codec list is invalid for {} media",
                    self.media_label(self.media_kind_from_create_kind(&create_kind))
                )))
            } else {
                rust_create()
            };
            if let Some(path) = staged_input.as_ref() {
                let _ = fs::remove_file(path);
            }
            let (header, media_kind) = create_result?;

            Ok(OperationReport::succeeded(
                OperationFamily::Container,
                Some(CHD.name.to_string()),
                "create",
                format!(
                    "created {} chd `{}` from `{}` ({} bytes, {})",
                    self.media_label(media_kind),
                    request.output.display(),
                    input.display(),
                    header.logical_bytes,
                    self.header_codec_label(header)
                ),
                Some(100.0),
                Some(execution),
            ))
        }

        fn capabilities(&self) -> ContainerCapabilities {
            ContainerCapabilities {
                inspect: true,
                extract: true,
                create: true,
                extract_threads: ThreadCapability::parallel(None),
                create_threads: ThreadCapability::parallel(None),
            }
        }
    }
}

use chd_native::ChdContainerHandler;
