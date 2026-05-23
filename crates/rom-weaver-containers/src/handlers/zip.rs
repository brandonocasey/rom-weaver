#[derive(Clone, Copy, Debug)]
enum ZipContainerFlavor {
    Zip,
    Zipx,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ZipCompressionMethod {
    Stored,
    Deflated,
    Bzip2,
    Zstd,
}

struct ZipContainerHandler {
    descriptor: &'static FormatDescriptor,
    flavor: ZipContainerFlavor,
}

struct ZipZstdPreparedEntry {
    archive_name: String,
    is_dir: bool,
    crc32: u32,
    uncompressed_size: u64,
    compressed_size: u64,
    compressed_data: Vec<u8>,
}

struct ZipZstdWrittenEntry {
    archive_name: String,
    is_dir: bool,
    crc32: u32,
    uncompressed_size: u64,
    compressed_size: u64,
    local_header_offset: u64,
}

impl ZipContainerHandler {
    const ZSTD_LEVEL_MIN: i32 = -7;
    const ZSTD_LEVEL_MAX: i32 = 22;
    const ZSTD_DEFAULT_LEVEL: i32 = 3;
    const ZSTD_METHOD_ID: u16 = 93;
    const STORE_METHOD_ID: u16 = 0;
    const ZIP_VERSION_DEFAULT: u16 = 20;
    const ZIP_VERSION_ZSTD: u16 = 63;
    const UTF8_FLAG: u16 = 1 << 11;
    const DOS_DATE_1980_01_01: u16 = 0x0021;
    const DOS_TIME_MIDNIGHT: u16 = 0;
    const ZIP64_EXTRA_ID: u16 = 0x0001;
    const ZSTD_CHUNK_BYTES: usize = 1024 * 1024;

    const fn new(descriptor: &'static FormatDescriptor, flavor: ZipContainerFlavor) -> Self {
        Self { descriptor, flavor }
    }

    fn parse_codec(
        &self,
        codec: Option<&str>,
        level: Option<i32>,
    ) -> Result<(ZipCompressionMethod, Option<i32>)> {
        let default = match self.flavor {
            ZipContainerFlavor::Zip => ZipCompressionMethod::Deflated,
            ZipContainerFlavor::Zipx => ZipCompressionMethod::Deflated,
        };
        let method = match parse_requested_codec(codec) {
            RequestedCodec::Unspecified => default,
            RequestedCodec::Known(CanonicalCodec::Store) => ZipCompressionMethod::Stored,
            RequestedCodec::Known(CanonicalCodec::Deflate) => ZipCompressionMethod::Deflated,
            RequestedCodec::Known(CanonicalCodec::Bzip2) => ZipCompressionMethod::Bzip2,
            RequestedCodec::Known(CanonicalCodec::Zstd) => ZipCompressionMethod::Zstd,
            RequestedCodec::Known(codec) => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported {} codec `{}`; supported codecs are store, deflate, bzip2, and zstd",
                    self.descriptor.name,
                    codec.name()
                )));
            }
            RequestedCodec::Unknown(name) => {
                return Err(RomWeaverError::Validation(format!(
                    "unsupported {} codec `{name}`; supported codecs are store, deflate, bzip2, and zstd",
                    self.descriptor.name
                )));
            }
        };

        if let Some(level) = level {
            let in_range = match method {
                ZipCompressionMethod::Stored => false,
                ZipCompressionMethod::Deflated => (0..=9).contains(&level),
                ZipCompressionMethod::Bzip2 => (1..=9).contains(&level),
                ZipCompressionMethod::Zstd => (-7..=22).contains(&level),
            };
            if !in_range {
                return Err(RomWeaverError::Validation(format!(
                    "level `{level}` is invalid for {} codec `{}`",
                    self.descriptor.name,
                    self.method_name(method)
                )));
            }
        }

        if method == ZipCompressionMethod::Stored && level.is_some() {
            return Err(RomWeaverError::Validation(format!(
                "{} codec `store` does not accept --level",
                self.descriptor.name
            )));
        }

        Ok((method, level))
    }

    fn method_name(&self, method: ZipCompressionMethod) -> &'static str {
        match method {
            ZipCompressionMethod::Stored => "store",
            ZipCompressionMethod::Deflated => "deflate",
            ZipCompressionMethod::Bzip2 => "bzip2",
            ZipCompressionMethod::Zstd => "zstd",
        }
    }

    fn libarchive_method_name(&self, method: ZipCompressionMethod) -> Option<&'static str> {
        match method {
            ZipCompressionMethod::Stored => Some("store"),
            ZipCompressionMethod::Deflated => Some("deflate"),
            ZipCompressionMethod::Bzip2 => Some("bzip2"),
            ZipCompressionMethod::Zstd => Some("zstd"),
        }
    }

    fn libarchive_level(&self, method: ZipCompressionMethod, level: Option<i32>) -> Option<i32> {
        match method {
            ZipCompressionMethod::Deflated => level,
            ZipCompressionMethod::Bzip2 => level,
            ZipCompressionMethod::Zstd => {
                level.map(|value| Self::map_zstd_level_to_zip_level(value))
            }
            _ => None,
        }
    }

    fn libarchive_threads(
        &self,
        method: ZipCompressionMethod,
        execution: &ThreadExecution,
    ) -> Option<usize> {
        match method {
            ZipCompressionMethod::Stored
            | ZipCompressionMethod::Deflated
            | ZipCompressionMethod::Bzip2
            | ZipCompressionMethod::Zstd => Some(execution.effective_threads.max(1)),
        }
    }

    fn create_thread_capability(&self, _method: ZipCompressionMethod) -> ThreadCapability {
        ThreadCapability::parallel(None)
    }

    fn libarchive_io_buffer_bytes(method: ZipCompressionMethod) -> usize {
        match method {
            ZipCompressionMethod::Zstd => LIBARCHIVE_CREATE_ZSTD_IO_BUFFER_BYTES,
            _ => LIBARCHIVE_CREATE_IO_BUFFER_BYTES,
        }
    }

    fn map_zstd_level_to_zip_level(level: i32) -> i32 {
        level.clamp(Self::ZSTD_LEVEL_MIN, Self::ZSTD_LEVEL_MAX)
    }

    fn zstd_chunk_size(input_len: usize, effective_threads: usize) -> usize {
        let target_chunks = effective_threads.saturating_mul(4).max(1);
        input_len
            .div_ceil(target_chunks)
            .max(Self::ZSTD_CHUNK_BYTES)
    }

    fn zip_entry_name(entry: &ArchiveInputEntry) -> String {
        if entry.is_dir && !entry.archive_name.ends_with('/') {
            format!("{}/", entry.archive_name)
        } else {
            entry.archive_name.clone()
        }
    }

    fn prepare_zstd_zip_entry(
        &self,
        entry: &ArchiveInputEntry,
        level: i32,
        execution: &ThreadExecution,
        pool: &SharedThreadPool,
    ) -> Result<ZipZstdPreparedEntry> {
        let archive_name = Self::zip_entry_name(entry);
        if entry.is_dir {
            return Ok(ZipZstdPreparedEntry {
                archive_name,
                is_dir: true,
                crc32: 0,
                uncompressed_size: 0,
                compressed_size: 0,
                compressed_data: Vec::new(),
            });
        }

        let data = fs::read(&entry.source)?;
        let crc32 = crc32fast::hash(&data);
        let compressed_chunks: Result<Vec<Vec<u8>>> = if data.is_empty() {
            Ok(vec![zstd_compress(&data, level).map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} create failed while compressing `{}` with zstd: {error}",
                    self.descriptor.name, archive_name
                ))
            })?])
        } else {
            let chunk_size = Self::zstd_chunk_size(data.len(), execution.effective_threads);
            if execution.used_parallelism && data.len() > chunk_size {
                pool.install(|| {
                    data.par_chunks(chunk_size)
                        .map(|chunk| {
                            zstd_compress(chunk, level).map_err(|error| {
                                RomWeaverError::Validation(format!(
                                    "{} create failed while compressing `{}` with zstd: {error}",
                                    self.descriptor.name, archive_name
                                ))
                            })
                        })
                        .collect()
                })
            } else {
                data.chunks(chunk_size)
                    .map(|chunk| {
                        zstd_compress(chunk, level).map_err(|error| {
                            RomWeaverError::Validation(format!(
                                "{} create failed while compressing `{}` with zstd: {error}",
                                self.descriptor.name, archive_name
                            ))
                        })
                    })
                    .collect()
            }
        };
        let compressed_chunks = compressed_chunks?;
        let compressed_size = compressed_chunks
            .iter()
            .try_fold(0u64, |total, chunk| -> Result<u64> {
                let chunk_len = u64::try_from(chunk.len()).map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "{} create failed: compressed chunk length overflowed",
                        self.descriptor.name
                    ))
                })?;
                Ok(total.saturating_add(chunk_len))
            })?;
        let mut compressed_data =
            Vec::with_capacity(usize::try_from(compressed_size).unwrap_or(usize::MAX));
        for chunk in compressed_chunks {
            compressed_data.extend_from_slice(&chunk);
        }

        Ok(ZipZstdPreparedEntry {
            archive_name,
            is_dir: false,
            crc32,
            uncompressed_size: u64::try_from(data.len()).map_err(|_| {
                RomWeaverError::Validation(format!(
                    "{} create failed: input length overflowed",
                    self.descriptor.name
                ))
            })?,
            compressed_size,
            compressed_data,
        })
    }

    fn create_with_native_zstd_zip(
        &self,
        request: &ContainerCreateRequest,
        entries: &[ArchiveInputEntry],
        level: Option<i32>,
        context: &OperationContext,
    ) -> Result<(u64, ThreadExecution)> {
        let (execution, pool) = context.build_pool(self.create_thread_capability(ZipCompressionMethod::Zstd))?;
        let level = level.unwrap_or(Self::ZSTD_DEFAULT_LEVEL);

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let output = File::create(&request.output)?;
        let mut writer = BufWriter::new(output);
        let mut offset = 0u64;
        let mut logical_bytes = 0u64;
        let mut written_entries = Vec::with_capacity(entries.len());
        let total_entries = entries.len();

        for (entry_index, entry) in entries.iter().enumerate() {
            let prepared = self.prepare_zstd_zip_entry(entry, level, &execution, &pool)?;
            logical_bytes = logical_bytes.saturating_add(prepared.uncompressed_size);
            let local_header_offset = offset;
            Self::write_zstd_zip_local_entry(&mut writer, &mut offset, &prepared)?;
            written_entries.push(ZipZstdWrittenEntry {
                archive_name: prepared.archive_name,
                is_dir: prepared.is_dir,
                crc32: prepared.crc32,
                uncompressed_size: prepared.uncompressed_size,
                compressed_size: prepared.compressed_size,
                local_header_offset,
            });
            emit_container_step_progress(
                context,
                "compress",
                self.descriptor.name,
                "create",
                entry_index.saturating_add(1),
                total_entries,
                format!(
                    "creating `{}` ({}/{})",
                    self.descriptor.name,
                    entry_index.saturating_add(1),
                    total_entries
                ),
                Some(&execution),
            );
        }

        let central_directory_offset = offset;
        let mut central_directory = Vec::new();
        for entry in &written_entries {
            Self::append_zstd_zip_central_entry(&mut central_directory, entry)?;
        }
        let central_directory_size = u64::try_from(central_directory.len()).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{} create failed: central directory size overflowed",
                self.descriptor.name
            ))
        })?;
        Self::write_counted(&mut writer, &mut offset, &central_directory)?;
        Self::write_zstd_zip_end(
            &mut writer,
            &mut offset,
            written_entries.len(),
            central_directory_size,
            central_directory_offset,
            self.descriptor.name,
        )?;
        writer.flush()?;

        Ok((logical_bytes, execution))
    }

    fn write_zstd_zip_local_entry<W: Write>(
        writer: &mut W,
        offset: &mut u64,
        entry: &ZipZstdPreparedEntry,
    ) -> Result<()> {
        let name = entry.archive_name.as_bytes();
        let extra = Self::zip64_local_extra(entry.uncompressed_size, entry.compressed_size);
        let method = if entry.is_dir {
            Self::STORE_METHOD_ID
        } else {
            Self::ZSTD_METHOD_ID
        };
        let version_needed = if entry.is_dir {
            Self::ZIP_VERSION_DEFAULT
        } else {
            Self::ZIP_VERSION_ZSTD
        };

        Self::write_u32_le(writer, offset, 0x0403_4b50)?;
        Self::write_u16_le(writer, offset, version_needed)?;
        Self::write_u16_le(writer, offset, Self::UTF8_FLAG)?;
        Self::write_u16_le(writer, offset, method)?;
        Self::write_u16_le(writer, offset, Self::DOS_TIME_MIDNIGHT)?;
        Self::write_u16_le(writer, offset, Self::DOS_DATE_1980_01_01)?;
        Self::write_u32_le(writer, offset, entry.crc32)?;
        Self::write_u32_le(writer, offset, Self::zip_u32_field(entry.compressed_size))?;
        Self::write_u32_le(writer, offset, Self::zip_u32_field(entry.uncompressed_size))?;
        Self::write_u16_le(writer, offset, Self::zip_len_u16(name.len(), "zip entry name")?)?;
        Self::write_u16_le(writer, offset, Self::zip_len_u16(extra.len(), "zip extra field")?)?;
        Self::write_counted(writer, offset, name)?;
        Self::write_counted(writer, offset, &extra)?;
        Self::write_counted(writer, offset, &entry.compressed_data)
    }

    fn append_zstd_zip_central_entry(
        output: &mut Vec<u8>,
        entry: &ZipZstdWrittenEntry,
    ) -> Result<()> {
        let name = entry.archive_name.as_bytes();
        let extra = Self::zip64_central_extra(
            entry.uncompressed_size,
            entry.compressed_size,
            entry.local_header_offset,
        );
        let method = if entry.is_dir {
            Self::STORE_METHOD_ID
        } else {
            Self::ZSTD_METHOD_ID
        };
        let version_needed = if entry.is_dir {
            Self::ZIP_VERSION_DEFAULT
        } else {
            Self::ZIP_VERSION_ZSTD
        };

        Self::append_u32_le(output, 0x0201_4b50);
        Self::append_u16_le(output, (3 << 8) | version_needed);
        Self::append_u16_le(output, version_needed);
        Self::append_u16_le(output, Self::UTF8_FLAG);
        Self::append_u16_le(output, method);
        Self::append_u16_le(output, Self::DOS_TIME_MIDNIGHT);
        Self::append_u16_le(output, Self::DOS_DATE_1980_01_01);
        Self::append_u32_le(output, entry.crc32);
        Self::append_u32_le(output, Self::zip_u32_field(entry.compressed_size));
        Self::append_u32_le(output, Self::zip_u32_field(entry.uncompressed_size));
        Self::append_u16_le(output, Self::zip_len_u16(name.len(), "zip entry name")?);
        Self::append_u16_le(output, Self::zip_len_u16(extra.len(), "zip extra field")?);
        Self::append_u16_le(output, 0);
        Self::append_u16_le(output, 0);
        Self::append_u16_le(output, 0);
        let external_attributes = if entry.is_dir {
            (0o040755_u32 << 16) | 0x10
        } else {
            0o100644_u32 << 16
        };
        Self::append_u32_le(output, external_attributes);
        Self::append_u32_le(output, Self::zip_u32_field(entry.local_header_offset));
        output.extend_from_slice(name);
        output.extend_from_slice(&extra);
        Ok(())
    }

    fn write_zstd_zip_end<W: Write>(
        writer: &mut W,
        offset: &mut u64,
        entry_count: usize,
        central_directory_size: u64,
        central_directory_offset: u64,
        format_name: &str,
    ) -> Result<()> {
        let entry_count_u64 = u64::try_from(entry_count).map_err(|_| {
            RomWeaverError::Validation(format!(
                "{format_name} create failed: entry count overflowed"
            ))
        })?;
        let needs_zip64 = entry_count > u16::MAX as usize
            || central_directory_size > u32::MAX as u64
            || central_directory_offset > u32::MAX as u64;
        if needs_zip64 {
            let zip64_eocd_offset = *offset;
            Self::write_u32_le(writer, offset, 0x0606_4b50)?;
            Self::write_u64_le(writer, offset, 44)?;
            Self::write_u16_le(writer, offset, Self::ZIP_VERSION_ZSTD)?;
            Self::write_u16_le(writer, offset, Self::ZIP_VERSION_ZSTD)?;
            Self::write_u32_le(writer, offset, 0)?;
            Self::write_u32_le(writer, offset, 0)?;
            Self::write_u64_le(writer, offset, entry_count_u64)?;
            Self::write_u64_le(writer, offset, entry_count_u64)?;
            Self::write_u64_le(writer, offset, central_directory_size)?;
            Self::write_u64_le(writer, offset, central_directory_offset)?;

            Self::write_u32_le(writer, offset, 0x0706_4b50)?;
            Self::write_u32_le(writer, offset, 0)?;
            Self::write_u64_le(writer, offset, zip64_eocd_offset)?;
            Self::write_u32_le(writer, offset, 1)?;
        }

        Self::write_u32_le(writer, offset, 0x0605_4b50)?;
        Self::write_u16_le(writer, offset, 0)?;
        Self::write_u16_le(writer, offset, 0)?;
        Self::write_u16_le(writer, offset, Self::zip_count_u16(entry_count, needs_zip64)?)?;
        Self::write_u16_le(writer, offset, Self::zip_count_u16(entry_count, needs_zip64)?)?;
        Self::write_u32_le(
            writer,
            offset,
            Self::zip_directory_u32(central_directory_size, needs_zip64),
        )?;
        Self::write_u32_le(
            writer,
            offset,
            Self::zip_directory_u32(central_directory_offset, needs_zip64),
        )?;
        Self::write_u16_le(writer, offset, 0)
    }

    fn zip64_local_extra(uncompressed_size: u64, compressed_size: u64) -> Vec<u8> {
        if uncompressed_size <= u32::MAX as u64 && compressed_size <= u32::MAX as u64 {
            return Vec::new();
        }
        let mut extra = Vec::with_capacity(20);
        Self::append_u16_le(&mut extra, Self::ZIP64_EXTRA_ID);
        Self::append_u16_le(&mut extra, 16);
        Self::append_u64_le(&mut extra, uncompressed_size);
        Self::append_u64_le(&mut extra, compressed_size);
        extra
    }

    fn zip64_central_extra(
        uncompressed_size: u64,
        compressed_size: u64,
        local_header_offset: u64,
    ) -> Vec<u8> {
        if uncompressed_size <= u32::MAX as u64
            && compressed_size <= u32::MAX as u64
            && local_header_offset <= u32::MAX as u64
        {
            return Vec::new();
        }
        let mut extra = Vec::with_capacity(28);
        Self::append_u16_le(&mut extra, Self::ZIP64_EXTRA_ID);
        Self::append_u16_le(&mut extra, 24);
        Self::append_u64_le(&mut extra, uncompressed_size);
        Self::append_u64_le(&mut extra, compressed_size);
        Self::append_u64_le(&mut extra, local_header_offset);
        extra
    }

    fn zip_u32_field(value: u64) -> u32 {
        if value > u32::MAX as u64 {
            u32::MAX
        } else {
            value as u32
        }
    }

    fn zip_directory_u32(value: u64, needs_zip64: bool) -> u32 {
        if needs_zip64 {
            u32::MAX
        } else {
            value as u32
        }
    }

    fn zip_count_u16(value: usize, needs_zip64: bool) -> Result<u16> {
        if needs_zip64 {
            Ok(u16::MAX)
        } else {
            u16::try_from(value).map_err(|_| {
                RomWeaverError::Validation("zip create failed: entry count overflowed".into())
            })
        }
    }

    fn zip_len_u16(value: usize, label: &str) -> Result<u16> {
        u16::try_from(value).map_err(|_| {
            RomWeaverError::Validation(format!("zip create failed: {label} exceeded 65535 bytes"))
        })
    }

    fn write_counted<W: Write>(writer: &mut W, offset: &mut u64, bytes: &[u8]) -> Result<()> {
        writer.write_all(bytes)?;
        *offset = offset.saturating_add(u64::try_from(bytes.len()).map_err(|_| {
            RomWeaverError::Validation("zip create failed: write length overflowed".into())
        })?);
        Ok(())
    }

    fn write_u16_le<W: Write>(writer: &mut W, offset: &mut u64, value: u16) -> Result<()> {
        Self::write_counted(writer, offset, &value.to_le_bytes())
    }

    fn write_u32_le<W: Write>(writer: &mut W, offset: &mut u64, value: u32) -> Result<()> {
        Self::write_counted(writer, offset, &value.to_le_bytes())
    }

    fn write_u64_le<W: Write>(writer: &mut W, offset: &mut u64, value: u64) -> Result<()> {
        Self::write_counted(writer, offset, &value.to_le_bytes())
    }

    fn append_u16_le(output: &mut Vec<u8>, value: u16) {
        output.extend_from_slice(&value.to_le_bytes());
    }

    fn append_u32_le(output: &mut Vec<u8>, value: u32) {
        output.extend_from_slice(&value.to_le_bytes());
    }

    fn append_u64_le(output: &mut Vec<u8>, value: u64) {
        output.extend_from_slice(&value.to_le_bytes());
    }

    fn create_with_libarchive(
        &self,
        request: &ContainerCreateRequest,
        entries: &[ArchiveInputEntry],
        method: ZipCompressionMethod,
        level: Option<i32>,
        context: &OperationContext,
    ) -> Result<(u64, ThreadExecution)> {
        if method == ZipCompressionMethod::Zstd {
            return self.create_with_native_zstd_zip(request, entries, level, context);
        }

        let execution = context.plan_threads(self.create_thread_capability(method));

        let method_name = self.libarchive_method_name(method).ok_or_else(|| {
            RomWeaverError::Unsupported(format!(
                "libarchive does not support {} codec `{}`",
                self.descriptor.name,
                self.method_name(method)
            ))
        })?;
        let logical_bytes = write_archive_with_libarchive(
            request,
            entries,
            context,
            &execution,
            LibarchiveCreateConfig {
                format_name: self.descriptor.name,
                format: LibarchiveCreateFormat::Zip,
                filter: LibarchiveCreateFilter::None,
                format_compression: Some(method_name),
                compression_level: self.libarchive_level(method, level),
                format_threads: self.libarchive_threads(method, &execution),
                filter_threads: None,
                io_buffer_bytes: Self::libarchive_io_buffer_bytes(method),
            },
        )?;
        Ok((logical_bytes, execution))
    }
}

impl ContainerHandler for ZipContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        probe_regular_archive_with_libarchive(
            source,
            self.descriptor.name,
            LibarchiveProbeFormat::Zip,
        )
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let summary =
            inspect_regular_archive_with_libarchive(&request.source, self.descriptor.name)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "{}: {} entries ({} files, {} directories), {} bytes compressed, {} bytes uncompressed",
                self.descriptor.name,
                summary.entries_total,
                summary.files,
                summary.directories,
                summary.archive_bytes,
                summary.logical_bytes
            ),
            Some(100.0),
            None,
        ))
    }

    fn list_entries(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<Vec<String>> {
        list_regular_archive_entries_with_libarchive(&request.source, self.descriptor.name)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        extract_regular_archive_with_libarchive(request, context, self.descriptor.name, true)
    }

    fn create(
        &self,
        request: &ContainerCreateRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let (method, level) = self.parse_codec(request.codec.as_deref(), request.level)?;
        let entries = collect_archive_inputs(&request.inputs)?;
        let (logical_bytes, execution) =
            self.create_with_libarchive(request, &entries, method, level, context)?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from {} input(s) with {} ({} bytes)",
                request.output.display(),
                request.inputs.len(),
                self.method_name(method),
                logical_bytes
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
