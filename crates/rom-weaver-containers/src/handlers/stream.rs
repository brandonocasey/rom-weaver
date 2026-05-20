#[derive(Clone, Copy, Debug)]
enum StreamCompression {
    Gzip,
    Bzip2,
    Xz,
    Zstd,
}

struct StreamContainerHandler {
    descriptor: &'static FormatDescriptor,
    compression: StreamCompression,
}

impl StreamContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor, compression: StreamCompression) -> Self {
        Self {
            descriptor,
            compression,
        }
    }

    fn parse_codec_and_level(&self, codec: Option<&str>, level: Option<i32>) -> Result<i32> {
        let codec = parse_requested_codec(codec);
        match self.compression {
            StreamCompression::Gzip => {
                match &codec {
                    RequestedCodec::Unspecified
                    | RequestedCodec::Known(CanonicalCodec::Deflate) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported gz codec `{}`; use gzip",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported gz codec `{codec}`; use gzip"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (0..=9).contains(&value) => Ok(value),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "gz level `{value}` is out of range (0..=9)"
                    ))),
                }
            }
            StreamCompression::Bzip2 => {
                match &codec {
                    RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Bzip2) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported bz2 codec `{}`; use bzip2",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported bz2 codec `{codec}`; use bzip2"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (1..=9).contains(&value) => Ok(value),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "bz2 level `{value}` is out of range (1..=9)"
                    ))),
                }
            }
            StreamCompression::Xz => {
                match &codec {
                    RequestedCodec::Unspecified
                    | RequestedCodec::Known(CanonicalCodec::Lzma)
                    | RequestedCodec::Known(CanonicalCodec::Lzma2) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported xz codec `{}`; use xz",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported xz codec `{codec}`; use xz"
                        )));
                    }
                }
                match level {
                    None => Ok(6),
                    Some(value) if (0..=9).contains(&value) => Ok(value),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "xz level `{value}` is out of range (0..=9)"
                    ))),
                }
            }
            StreamCompression::Zstd => {
                match &codec {
                    RequestedCodec::Unspecified | RequestedCodec::Known(CanonicalCodec::Zstd) => {
                        // Allowed.
                    }
                    RequestedCodec::Known(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported zst codec `{}`; use zstd",
                            codec.name()
                        )));
                    }
                    RequestedCodec::Unknown(codec) => {
                        return Err(RomWeaverError::Validation(format!(
                            "unsupported zst codec `{codec}`; use zstd"
                        )));
                    }
                }
                match level {
                    None => Ok(3),
                    Some(value) if (-7..=22).contains(&value) => Ok(value),
                    Some(value) => Err(RomWeaverError::Validation(format!(
                        "zst level `{value}` is out of range (-7..=22)"
                    ))),
                }
            }
        }
    }

    fn backend_codec_name(&self) -> &'static str {
        match self.compression {
            StreamCompression::Gzip => "deflate",
            StreamCompression::Bzip2 => "bzip2",
            StreamCompression::Xz => "lzma2",
            StreamCompression::Zstd => "zstd",
        }
    }

    fn extract_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            StreamCompression::Gzip
            | StreamCompression::Bzip2
            | StreamCompression::Xz
            | StreamCompression::Zstd => ThreadCapability::parallel(None),
        }
    }

    fn create_thread_capability(&self) -> ThreadCapability {
        match self.compression {
            StreamCompression::Gzip
            | StreamCompression::Bzip2
            | StreamCompression::Xz
            | StreamCompression::Zstd => ThreadCapability::parallel(None),
        }
    }

    fn codec_backend(&self) -> Result<Arc<dyn CodecBackend>> {
        let codec = self.backend_codec_name();
        resolve_container_codec_backend(self.descriptor.name, codec)
    }

    fn output_name(&self, source: &Path) -> String {
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(self.descriptor.name);
        let file_name_lower = file_name.to_ascii_lowercase();
        let mut longest_extension = 0usize;
        for extension in self.descriptor.extensions {
            let extension_lower = extension.to_ascii_lowercase();
            if file_name_lower.ends_with(&extension_lower)
                && extension_lower.len() > longest_extension
            {
                longest_extension = extension_lower.len();
            }
        }

        let trimmed = if longest_extension > 0 && longest_extension < file_name.len() {
            file_name[..file_name.len() - longest_extension].to_string()
        } else {
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(file_name)
                .to_string()
        };

        let normalized = trimmed.trim().trim_matches('.');
        if normalized.is_empty() {
            format!("{}.out", self.descriptor.name)
        } else {
            normalized.to_string()
        }
    }

    fn matches_signature(&self, source: &Path) -> bool {
        match self.compression {
            StreamCompression::Gzip => file_starts_with(source, &GZIP_SIGNATURE),
            StreamCompression::Bzip2 => file_starts_with(source, &BZIP2_SIGNATURE),
            StreamCompression::Xz => file_starts_with(source, &XZ_SIGNATURE),
            StreamCompression::Zstd => file_starts_with(source, &ZSTD_SIGNATURE),
        }
    }
}

impl ContainerHandler for StreamContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        if self.matches_signature(source) {
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
        let compressed_bytes = fs::metadata(&request.source)?.len();
        let mut execution = context.plan_threads(self.extract_thread_capability());
        let backend = self.codec_backend()?;
        let decoded_path = context
            .temp_paths()
            .next_path("stream-inspect", Some("bin"));
        let logical_bytes_result = (|| -> Result<u64> {
            let decode_report = backend.decode(
                &CodecOperationRequest {
                    input: request.source.clone(),
                    output: decoded_path.clone(),
                    level: None,
                },
                context,
            )?;
            if decode_report.status != OperationStatus::Succeeded {
                return Err(RomWeaverError::Unsupported(decode_report.label));
            }
            if let Some(decode_execution) = decode_report.thread_execution {
                execution = decode_execution;
            }
            Ok(fs::metadata(&decoded_path)?.len())
        })();
        let _ = fs::remove_file(&decoded_path);
        let logical_bytes = logical_bytes_result?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "{}: {} bytes compressed, {} bytes uncompressed",
                self.descriptor.name, compressed_bytes, logical_bytes
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
        Ok(vec![self.output_name(&request.source)])
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let mut execution = context.plan_threads(self.extract_thread_capability());
        fs::create_dir_all(&request.out_dir)?;

        let output_name = self.output_name(&request.source);
        let mut selections = SelectionMatcher::new(&request.selections);
        if !selections.matches(&output_name) {
            selections.ensure_all_matched()?;
        }

        let output_path = request.out_dir.join(&output_name);
        let backend = self.codec_backend()?;
        let decode_report = backend.decode(
            &CodecOperationRequest {
                input: request.source.clone(),
                output: output_path.clone(),
                level: None,
            },
            context,
        )?;
        if decode_report.status != OperationStatus::Succeeded {
            return Err(RomWeaverError::Unsupported(decode_report.label));
        }
        if let Some(decode_execution) = decode_report.thread_execution {
            execution = decode_execution;
        }
        let written = fs::metadata(&output_path)?.len();
        selections.ensure_all_matched()?;

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` (1 file, {} bytes written)",
                request.source.display(),
                output_path.display(),
                written
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
            return Err(RomWeaverError::Validation(format!(
                "{} create currently requires exactly one input file",
                self.descriptor.name
            )));
        }

        let mut execution = context.plan_threads(self.create_thread_capability());
        let level = self.parse_codec_and_level(request.codec.as_deref(), request.level)?;
        let input = &request.inputs[0];
        let metadata = fs::metadata(input)?;
        if !metadata.is_file() {
            return Err(RomWeaverError::Validation(format!(
                "{} create requires a file input: `{}`",
                self.descriptor.name,
                input.display()
            )));
        }
        let logical_bytes = metadata.len();

        if let Some(parent) = request.output.parent() {
            fs::create_dir_all(parent)?;
        }

        let backend = self.codec_backend()?;
        let encode_report = backend.encode(
            &CodecOperationRequest {
                input: input.clone(),
                output: request.output.clone(),
                level: Some(level),
            },
            context,
        )?;
        if encode_report.status != OperationStatus::Succeeded {
            return Err(RomWeaverError::Unsupported(encode_report.label));
        }
        if let Some(encode_execution) = encode_report.thread_execution {
            execution = encode_execution;
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "create",
            format!(
                "created `{}` from `{}` ({} bytes)",
                request.output.display(),
                input.display(),
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
            extract_threads: self.extract_thread_capability(),
            create_threads: self.create_thread_capability(),
        }
    }
}

const CSO_DEFAULT_BLOCK_BYTES: usize = 2 * 1024;
const CSO_EXTRACT_TASK_BYTES: u64 = 8 * 1024 * 1024;
const CSO_CREATE_TASK_SECTORS: usize = 2048;

