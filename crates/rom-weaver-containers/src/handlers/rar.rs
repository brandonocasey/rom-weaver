
struct RarContainerHandler {
    descriptor: &'static FormatDescriptor,
}

#[derive(Clone, Debug)]
struct RarExtractTask {
    index: usize,
    output_path: PathBuf,
    is_directory: bool,
}

impl RarContainerHandler {
    const fn new(descriptor: &'static FormatDescriptor) -> Self {
        Self { descriptor }
    }

    fn open_archive(&self, source: &Path) -> Result<rars::Archive> {
        RarRsArchiveReader::read_path(source)
            .map_err(|error| RomWeaverError::Validation(format!("rar archive is invalid: {error}")))
    }

    fn build_extract_tasks(
        &self,
        request: &ContainerExtractRequest,
        archive: &rars::Archive,
    ) -> Result<Vec<RarExtractTask>> {
        let mut selections = SelectionMatcher::new(&request.selections);
        let mut tasks = Vec::new();

        for (index, member) in archive.members().enumerate() {
            let entry_name =
                normalize_archive_name(&String::from_utf8_lossy(member.meta.name_bytes()));
            if entry_name.is_empty() || !selections.matches(&entry_name) {
                continue;
            }

            let relative = sanitize_archive_relative_path_from_str(&entry_name)?;
            tasks.push(RarExtractTask {
                index,
                output_path: request.out_dir.join(relative),
                is_directory: member.meta.is_directory,
            });
        }

        selections.ensure_all_matched()?;
        Ok(tasks)
    }

    fn extract_task_chunk(&self, source: &Path, chunk: &[RarExtractTask]) -> Result<(usize, u64)> {
        if chunk.is_empty() {
            return Ok((0, 0));
        }

        let archive = self.open_archive(source)?;
        let mut task_by_index = BTreeMap::new();
        for task in chunk {
            task_by_index.insert(task.index, task);
        }

        let mut entry_index = 0usize;
        let mut matched_tasks = 0usize;
        let mut extracted_paths = Vec::new();

        archive
            .extract_to(None, |meta| {
                let current_index = entry_index;
                entry_index = entry_index.saturating_add(1);
                let Some(task) = task_by_index.get(&current_index).copied() else {
                    return Ok(Box::new(io::sink()) as Box<dyn Write>);
                };

                matched_tasks = matched_tasks.saturating_add(1);
                if task.is_directory || meta.is_directory {
                    fs::create_dir_all(&task.output_path)?;
                    return Ok(Box::new(io::sink()) as Box<dyn Write>);
                }

                if let Some(parent) = task.output_path.parent() {
                    fs::create_dir_all(parent)?;
                }

                extracted_paths.push(task.output_path.clone());
                Ok(Box::new(BufWriter::new(File::create(&task.output_path)?)) as Box<dyn Write>)
            })
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "rar extract failed for `{}`: {error}",
                    source.display()
                ))
            })?;

        if matched_tasks != task_by_index.len() {
            return Err(RomWeaverError::Validation(
                "rar extract failed because selected entries changed while processing".into(),
            ));
        }

        let mut extracted_files = 0usize;
        let mut written_bytes = 0u64;
        for path in extracted_paths {
            let metadata = fs::metadata(&path)?;
            if metadata.is_file() {
                extracted_files = extracted_files.saturating_add(1);
                written_bytes = written_bytes.saturating_add(metadata.len());
            }
        }

        Ok((extracted_files, written_bytes))
    }
}

impl ContainerHandler for RarContainerHandler {
    fn descriptor(&self) -> &'static FormatDescriptor {
        self.descriptor
    }

    fn probe(&self, source: &Path) -> ProbeConfidence {
        let mut signature = [0u8; RAR5_SIGNATURE.len()];
        if let Ok(mut file) = File::open(source) {
            if let Ok(read) = file.read(&mut signature) {
                if read >= RAR4_SIGNATURE.len()
                    && signature[..RAR4_SIGNATURE.len()] == RAR4_SIGNATURE
                {
                    return ProbeConfidence::Signature;
                }
                if read >= RAR5_SIGNATURE.len() && signature == RAR5_SIGNATURE {
                    return ProbeConfidence::Signature;
                }
            }
        }
        ProbeConfidence::Extension
    }

    fn inspect(
        &self,
        request: &ContainerInspectRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        let archive = self.open_archive(&request.source)?;
        let mut files = 0usize;
        let mut directories = 0usize;
        let mut logical_bytes = 0u64;
        let mut entries_total = 0usize;

        for member in archive.members() {
            let entry_name =
                normalize_archive_name(&String::from_utf8_lossy(member.meta.name_bytes()));
            if entry_name.is_empty() {
                continue;
            }
            entries_total = entries_total.saturating_add(1);
            if member.meta.is_directory {
                directories = directories.saturating_add(1);
            } else {
                files = files.saturating_add(1);
                logical_bytes = logical_bytes.saturating_add(member.meta.unpacked_size);
            }
        }

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "inspect",
            format!(
                "rar: {} entries ({} files, {} directories), {} bytes uncompressed",
                entries_total, files, directories, logical_bytes
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
        let archive = self.open_archive(&request.source)?;
        let mut entries = Vec::new();
        for member in archive.members() {
            let entry_name =
                normalize_archive_name(&String::from_utf8_lossy(member.meta.name_bytes()));
            if !entry_name.is_empty() {
                entries.push(entry_name);
            }
        }
        Ok(entries)
    }

    fn extract(
        &self,
        request: &ContainerExtractRequest,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        fs::create_dir_all(&request.out_dir)?;
        let archive = self.open_archive(&request.source)?;
        let tasks = self.build_extract_tasks(request, &archive)?;
        let mut output_paths = BTreeSet::new();
        let mut duplicate_output_paths = false;
        for task in &tasks {
            if task.is_directory {
                continue;
            }
            duplicate_output_paths |= !output_paths.insert(task.output_path.clone());
        }

        let (execution, extracted_files, written_bytes) =
            if tasks.is_empty() || duplicate_output_paths {
                let execution = context.plan_threads(ThreadCapability::single_threaded());
                let (extracted_files, written_bytes) =
                    self.extract_task_chunk(&request.source, &tasks)?;
                (execution, extracted_files, written_bytes)
            } else {
                let task_count = tasks.len().max(1);
                let (execution, pool) =
                    context.build_pool(ThreadCapability::parallel(Some(task_count)))?;
                let source = request.source.clone();
                let (extracted_files, written_bytes) = if execution.used_parallelism {
                    let worker_count = execution.effective_threads.max(1);
                    let chunk_size = tasks.len().div_ceil(worker_count).max(1);
                    let chunk_results = pool.install(|| {
                        tasks
                            .par_chunks(chunk_size)
                            .map(|chunk| self.extract_task_chunk(&source, chunk))
                            .collect::<Result<Vec<_>>>()
                    })?;
                    chunk_results.into_iter().fold(
                        (0usize, 0u64),
                        |(files_acc, bytes_acc), (files, bytes)| {
                            (
                                files_acc.saturating_add(files),
                                bytes_acc.saturating_add(bytes),
                            )
                        },
                    )
                } else {
                    self.extract_task_chunk(&source, &tasks)?
                };
                (execution, extracted_files, written_bytes)
            };

        Ok(OperationReport::succeeded(
            OperationFamily::Container,
            Some(self.descriptor.name.to_string()),
            "extract",
            format!(
                "extracted `{}` to `{}` ({} file(s), {} bytes written)",
                request.source.display(),
                request.out_dir.display(),
                extracted_files,
                written_bytes
            ),
            Some(100.0),
            Some(execution),
        ))
    }

    fn create(
        &self,
        _request: &ContainerCreateRequest,
        _context: &OperationContext,
    ) -> Result<OperationReport> {
        Err(RomWeaverError::Validation(
            "rar create is not supported".into(),
        ))
    }

    fn capabilities(&self) -> ContainerCapabilities {
        ContainerCapabilities {
            inspect: true,
            extract: true,
            create: false,
            extract_threads: ThreadCapability::parallel(None),
            create_threads: ThreadCapability::single_threaded(),
        }
    }
}

