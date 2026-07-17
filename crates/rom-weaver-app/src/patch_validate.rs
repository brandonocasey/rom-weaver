use super::*;

use rayon::prelude::*;

use super::patch_commands::{
    PatchApplyProgressSink, PatchApplyProgressTracker, patch_progress_segment_start,
};

impl CliApp {
    pub(super) fn run_patch_validate(&self, args: PatchValidateCommand) -> AppRunOutcome {
        trace!(
            input = %args.input.display(),
            selections = args.select.len(),
            rom_filter = args.rom_filter,
            patch_filter = args.patch_filter,
            patch_count = args.patches.len(),
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            checksum_cache = args.checksum_cache.len(),
            validate_with_checksums = args.validate_with_checksums.len(),
            validate_with_size = ?args.validate_with_size,
            validate_with_min_size = ?args.validate_with_min_size,
            strip_header = args.strip_header,
            n64_byte_order = ?args.n64_byte_order,
            ignore_checksum_validation = args.ignore_checksum_validation,
            independent = args.independent,
            threads = %args.threads,
            "starting patch-validate command"
        );
        let PatchValidateCommand {
            input,
            select,
            rom_filter,
            patch_filter,
            no_extract,
            no_ignore,
            patches,
            checksum_cache,
            validate_with_checksums,
            validate_with_size,
            validate_with_min_size,
            strip_header,
            n64_byte_order,
            ignore_checksum_validation,
            independent,
            threads,
        } = args;
        let input_kind_filter = Self::archive_entry_kind_filter(rom_filter, false);
        let patch_kind_filter = Self::archive_entry_kind_filter(false, patch_filter);
        let context =
            self.context(threads)
                .with_patch_checksum_validation(if ignore_checksum_validation {
                    PatchChecksumValidation::Ignore
                } else {
                    PatchChecksumValidation::Strict
                });
        let probe_threads = context.single_thread_execution();
        let fail = |stage: &str, message: String| {
            OperationReport::failed(
                OperationFamily::Patch,
                None,
                stage,
                message,
                probe_threads.clone(),
            )
        };
        let cached_input_checksums =
            match Self::parse_patch_apply_checksum_values(&checksum_cache, "--checksum-cache") {
                Ok(values) => values,
                Err(error) => {
                    return self.finish("patch-validate", fail("validate", error.to_string()));
                }
            };
        let n64_byte_order = n64_byte_order.unwrap_or_default();
        let mut expected_input_checksums = match Self::parse_patch_apply_checksum_values(
            &validate_with_checksums,
            "--validate-with-checksum",
        ) {
            Ok(values) => values,
            Err(error) => {
                return self.finish("patch-validate", fail("validate", error.to_string()));
            }
        };
        let mut effective_expected_size = validate_with_size;
        if !ignore_checksum_validation
            && let Some(first_patch) = patches.first()
            && let Some(patch_name) = first_patch.file_name().and_then(|name| name.to_str())
            && let Some(report) = self.merge_filename_requirements(
                "patch-validate",
                first_patch,
                patch_name,
                &mut expected_input_checksums,
                &mut effective_expected_size,
                probe_threads.clone(),
            )
        {
            return self.finish("patch-validate", report);
        }
        if let Some(report) = self.require_existing_path(
            "patch-validate",
            OperationFamily::Patch,
            None,
            &input,
            probe_threads.clone(),
        ) {
            return self.finish("patch-validate", report);
        }
        for patch_path in &patches {
            if let Some(report) = self.require_existing_path(
                "patch-validate",
                OperationFamily::Patch,
                None,
                patch_path,
                probe_threads.clone(),
            ) {
                return self.finish("patch-validate", report);
            }
        }

        let resolved_input = match self.resolve_source_with_auto_extract(
            &input,
            &select,
            &context,
            AutoExtractResolutionLabels {
                command: "patch-validate",
                family: OperationFamily::Patch,
                format: None,
                source_label: "patch validate input",
                temp_prefix: "patch-validate-input-extract",
            },
            AutoExtractResolutionFlags {
                no_extract,
                no_ignore,
                kind_filter: input_kind_filter,
                stop_on_disc_image_codec: false,
            },
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish("patch-validate", fail("prepare", error.to_string()));
            }
        };
        let ResolvedChecksumSource {
            source: resolved_input,
            extracted_archives,
            cleanup_paths,
        } = resolved_input;
        // Reuse the host-provided input checksums (the CRC32 the webapp already computed during
        // staging) for the handler's source-checksum verification - the dry-run apply otherwise
        // re-reads the whole input just to re-derive a CRC32 we already have.
        context.seed_checksums(&resolved_input, &cached_input_checksums);
        let mut temp_paths = cleanup_paths;
        let (resolved_patches, extracted_patch_notes) = match self.resolve_patches(
            &patches,
            &select,
            &context,
            AutoExtractResolutionFlags {
                no_extract,
                no_ignore,
                kind_filter: patch_kind_filter,
                stop_on_disc_image_codec: false,
            },
            PatchResolveLabels {
                command: "patch-validate",
                noun: "patch validate",
                temp_prefix: "patch-validate-patch-extract",
            },
            &mut temp_paths,
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish("patch-validate", fail("prepare", error.to_string()));
            }
        };

        let report = (|| {
            if patches.is_empty() {
                return fail(
                    "validate",
                    "at least one --patch value is required".to_string(),
                );
            }

            let mut validation_labels = Vec::new();
            let validate_input = if strip_header {
                self.emit_running(
                    OperationLabel {
                        command: "patch-validate",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "prepare",
                    "stripping ROM header before patch validation",
                    None,
                    None,
                );
                let stripped_path = context
                    .temp_paths()
                    .next_path("patch-validate-input-noheader", Some("bin"));
                match Self::strip_header_to_temp(&resolved_input, &stripped_path) {
                    Ok(_result) => {
                        temp_paths.push(stripped_path.clone());
                        stripped_path
                    }
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "compat",
                            error.to_string(),
                            context.single_thread_execution(),
                        );
                    }
                }
            } else {
                resolved_input.clone()
            };
            let mut n64_order = None;
            let validate_input = match self.resolve_patch_n64_target(
                &validate_input,
                resolved_patches.first().map(|(_, patch)| patch.as_path()),
                expected_input_checksums.get("crc32").map(String::as_str),
                n64_byte_order,
                &context,
            ) {
                Ok(Some((source_order, target_order))) => {
                    n64_order = Some(N64ByteOrderTransform {
                        from: target_order,
                        to: source_order,
                    });
                    if source_order == target_order {
                        validate_input
                    } else {
                        self.emit_running(
                            OperationLabel {
                                command: "patch-validate",
                                family: OperationFamily::Patch,
                                format: None,
                            },
                            "compat",
                            format!(
                                "transforming N64 input byte order to {}",
                                target_order.label()
                            ),
                            None,
                            context.single_thread_execution(),
                        );
                        let transformed_path = context
                            .temp_paths()
                            .next_path("patch-validate-input-n64-byte-order", Some("bin"));
                        if let Err(error) = Self::rewrite_n64_byte_order(
                            &validate_input,
                            &transformed_path,
                            source_order,
                            target_order,
                        ) {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                None,
                                "compat",
                                error.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                        temp_paths.push(transformed_path.clone());
                        transformed_path
                    }
                }
                Ok(None) => validate_input,
                Err(error) => {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "compat",
                        error.to_string(),
                        context.single_thread_execution(),
                    );
                }
            };
            let transformed_checksum_hints = BTreeMap::new();
            let effective_checksum_hints = if validate_input == resolved_input {
                &cached_input_checksums
            } else {
                &transformed_checksum_hints
            };
            if effective_expected_size.is_some() || validate_with_min_size.is_some() {
                match Self::validate_patch_input_size(
                    &validate_input,
                    effective_expected_size,
                    validate_with_min_size,
                ) {
                    Ok(label) => validation_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            context.single_thread_execution(),
                        );
                    }
                }
            }
            if !expected_input_checksums.is_empty() {
                self.emit_running(
                    OperationLabel {
                        command: "patch-validate",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "validate",
                    format!(
                        "validating {} requested input checksum(s)",
                        expected_input_checksums.len()
                    ),
                    None,
                    context.single_thread_execution(),
                );
                match Self::validate_patch_apply_expected_checksums(
                    &validate_input,
                    &expected_input_checksums,
                    effective_checksum_hints,
                    "input",
                    &context,
                ) {
                    Ok(label) => validation_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            context.single_thread_execution(),
                        );
                    }
                }
            }

            if independent {
                return self.run_patch_validate_independent(
                    &resolved_patches,
                    &validate_input,
                    &context,
                    probe_threads.clone(),
                    IndependentValidationSummary {
                        extracted_archives,
                        n64_byte_order: (n64_order.is_some()
                            || n64_byte_order != PatchN64ByteOrderMode::Auto)
                            .then_some(n64_byte_order),
                        extracted_patch_notes,
                        validation_labels,
                        min_size: validate_with_min_size,
                        expected_size: effective_expected_size,
                        expected_input_checksums: expected_input_checksums.clone(),
                    },
                );
            }

            let patch_count = resolved_patches.len();
            let mut current_input = validate_input;
            let mut formats = Vec::with_capacity(patch_count);
            for (index, (patch_path, resolved_patch_path)) in resolved_patches.iter().enumerate() {
                let handler = match self.probe_patch_handler(
                    patch_path,
                    resolved_patch_path,
                    index,
                    patch_count,
                    probe_threads.clone(),
                ) {
                    Ok(handler) => handler,
                    Err(report) => return *report,
                };
                if !handler.capabilities().apply {
                    return OperationReport::unsupported(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "validate",
                        format!(
                            "{} does not support dry-run validation",
                            handler.descriptor().name
                        ),
                        context.single_thread_execution(),
                    );
                }
                formats.push(handler.descriptor().name.to_string());

                if index > 0
                    && let Err(error) = self.transition_n64_byte_order(
                        n64_byte_order,
                        resolved_patch_path,
                        &mut current_input,
                        &mut n64_order,
                        &context,
                        &mut temp_paths,
                    )
                {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "prepare",
                        format!(
                            "patch {}/{} (`{}`): N64 byte-order transition failed: {error}",
                            index + 1,
                            patch_count,
                            patch_path.display()
                        ),
                        context.single_thread_execution(),
                    );
                }

                self.emit_running(
                    OperationLabel {
                        command: "patch-validate",
                        family: OperationFamily::Patch,
                        format: Some(handler.descriptor().name),
                    },
                    "validate",
                    if patch_count == 1 {
                        format!("validating patch using {}", handler.descriptor().name)
                    } else {
                        format!(
                            "validating patch {}/{} using {} (`{}`)",
                            index + 1,
                            patch_count,
                            handler.descriptor().name,
                            patch_path.display()
                        )
                    },
                    Some(patch_progress_segment_start(index, patch_count)),
                    None,
                );

                let progress_tracker = Arc::new(PatchApplyProgressTracker::default());
                let patch_context = context.clone().with_progress_sink(Arc::new(
                    PatchApplyProgressSink::new_for_command(
                        context.progress_sink(),
                        index,
                        patch_count,
                        progress_tracker.clone(),
                        "patch-validate",
                        "validate",
                    ),
                ));

                let mut validate_output = None;
                let report = if patch_count == 1 {
                    let request = PatchValidateRequest {
                        input: current_input.clone(),
                        patches: vec![resolved_patch_path.clone()],
                    };
                    match handler.validate(&request, &patch_context) {
                        Ok(report) => report,
                        Err(RomWeaverError::Unsupported(op)) => {
                            return OperationReport::unsupported(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                op.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                error.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                    }
                } else {
                    let output = context
                        .temp_paths()
                        .next_path("patch-validate-output-step", Some("bin"));
                    temp_paths.push(output.clone());
                    if let Some(parent) = output.parent()
                        && !parent.exists()
                        && let Err(error) = fs::create_dir_all(parent)
                    {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            Some(handler.descriptor().name.to_string()),
                            "prepare",
                            format!(
                                "failed to prepare validation output path `{}`: {error}",
                                output.display()
                            ),
                            context.single_thread_execution(),
                        );
                    }

                    let request = PatchApplyRequest {
                        input: current_input.clone(),
                        patches: vec![resolved_patch_path.clone()],
                        output: output.clone(),
                    };
                    let report = match handler.apply(&request, &patch_context) {
                        Ok(report) => report,
                        Err(RomWeaverError::Unsupported(op)) => {
                            return OperationReport::unsupported(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                op.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                error.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                    };
                    validate_output = Some(output);
                    report
                };
                if report.status != OperationStatus::Succeeded {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "validate",
                        report.label,
                        report
                            .thread_execution
                            .or_else(|| context.single_thread_execution()),
                    );
                }
                if !progress_tracker.saw_meaningful_running_progress() {
                    self.emit_running(
                        OperationLabel {
                            command: "patch-validate",
                            family: OperationFamily::Patch,
                            format: Some(handler.descriptor().name),
                        },
                        "validate",
                        if patch_count == 1 {
                            format!("validated patch using {}", handler.descriptor().name)
                        } else {
                            format!(
                                "validated patch {}/{} using {} (`{}`)",
                                index + 1,
                                patch_count,
                                handler.descriptor().name,
                                patch_path.display()
                            )
                        },
                        None,
                        report.thread_execution.clone(),
                    );
                }
                if let Some(output) = validate_output {
                    current_input = output;
                }
            }

            if extracted_archives > 0 {
                validation_labels.push(format!(
                    "input resolved via {extracted_archives} container extract step(s)"
                ));
            }
            if n64_order.is_some() || n64_byte_order != PatchN64ByteOrderMode::Auto {
                validation_labels.push(format!("n64_byte_order={}", n64_byte_order.id()));
            }
            validation_labels.extend(extracted_patch_notes);
            let format_label = if formats.is_empty() {
                "patch".to_string()
            } else {
                formats.join(", ")
            };
            let suffix = if validation_labels.is_empty() {
                String::new()
            } else {
                format!("; {}", validation_labels.join("; "))
            };
            let final_format = formats.last().cloned();
            let mut report = OperationReport::succeeded(
                OperationFamily::Patch,
                final_format.clone(),
                "validate",
                format!(
                    "patch validation passed for {} patch(es) ({format_label}){suffix}",
                    patch_count
                ),
                Some(100.0),
                context.single_thread_execution(),
            );
            report.details = Some(json!({
                "patch_validation": {
                    "dry_run": true,
                    "format": final_format,
                    "formats": formats,
                    "patch_count": patch_count,
                    "source_values": {
                        "minimum_size": validate_with_min_size,
                        "size": effective_expected_size,
                        "checksums": expected_input_checksums,
                    },
                    "status": "passed",
                }
            }));
            report
        })();

        Self::cleanup_temp_paths(&temp_paths);
        self.finish("patch-validate", report)
    }

    /// Validate each patch independently against the ORIGINAL prepared input (no
    /// sequential chaining). A single failing patch never aborts the others - the
    /// command collects a per-patch verdict for every patch and exits 0 so the
    /// webapp can read individual results (a hard failure would lose them). A
    /// genuine cancellation is the sole exception: it returns a `Cancelled`
    /// failure so the whole call maps to a retryable "unknown".
    fn run_patch_validate_independent(
        &self,
        resolved_patches: &[(PathBuf, PathBuf)],
        validate_input: &Path,
        context: &OperationContext,
        probe_threads: Option<ThreadExecution>,
        summary: IndependentValidationSummary,
    ) -> OperationReport {
        let patch_count = resolved_patches.len();
        debug!(
            patch_count,
            "patch-validate running independent (non-chained) per-patch validation"
        );

        // Probe each patch's handler sequentially (cheap header sniffing). Patches whose handler
        // cannot be resolved - or that cannot dry-run apply - become already-decided "failed"
        // verdicts rather than aborting the batch.
        let mut ready_jobs: Vec<IndependentReadyJob> = Vec::new();
        let mut decided: Vec<PerPatchVerdict> = Vec::new();
        for (index, (patch_path, resolved_patch_path)) in resolved_patches.iter().enumerate() {
            let patch_label = patch_path.to_string_lossy().to_string();
            match self.probe_patch_handler(
                patch_path,
                resolved_patch_path,
                index,
                patch_count,
                probe_threads.clone(),
            ) {
                Ok(handler) => {
                    let format = handler.descriptor().name.to_string();
                    if handler.capabilities().apply {
                        ready_jobs.push(IndependentReadyJob {
                            index,
                            patch: patch_label,
                            resolved: resolved_patch_path.clone(),
                            format,
                            handler,
                        });
                    } else {
                        let message = format!("{format} does not support dry-run validation");
                        trace!(
                            index,
                            patch_count, format, "independent patch verdict: failed (unsupported)"
                        );
                        decided.push(PerPatchVerdict {
                            index,
                            patch: patch_label,
                            format: Some(format),
                            passed: false,
                            message,
                        });
                    }
                }
                Err(report) => {
                    trace!(
                        index,
                        patch_count, "independent patch verdict: failed (probe)"
                    );
                    decided.push(PerPatchVerdict {
                        index,
                        patch: patch_label,
                        format: report.format.clone(),
                        passed: false,
                        message: report.label.clone(),
                    });
                }
            }
        }

        // Fan the dry-runs out across the op's thread budget (capped at the number of runnable
        // patches). On the non-threaded wasm build this negotiates to a single thread, so the batch
        // still runs - just serially. A per-patch `Cancelled` is the only error that aborts the whole
        // batch; every other handler error is captured as that patch's "failed" verdict.
        let run_one =
            |job: &IndependentReadyJob| -> std::result::Result<PerPatchVerdict, RomWeaverError> {
                let request = PatchValidateRequest {
                    input: validate_input.to_path_buf(),
                    patches: vec![job.resolved.clone()],
                };
                let verdict = match job.handler.validate(&request, context) {
                    Ok(report) if report.status == OperationStatus::Succeeded => PerPatchVerdict {
                        index: job.index,
                        patch: job.patch.clone(),
                        format: Some(job.format.clone()),
                        passed: true,
                        message: report.label,
                    },
                    Ok(report) => PerPatchVerdict {
                        index: job.index,
                        patch: job.patch.clone(),
                        format: Some(job.format.clone()),
                        passed: false,
                        message: report.label,
                    },
                    Err(RomWeaverError::Cancelled) => return Err(RomWeaverError::Cancelled),
                    Err(RomWeaverError::Unsupported(op)) => PerPatchVerdict {
                        index: job.index,
                        patch: job.patch.clone(),
                        format: Some(job.format.clone()),
                        passed: false,
                        message: op.to_string(),
                    },
                    Err(error) => PerPatchVerdict {
                        index: job.index,
                        patch: job.patch.clone(),
                        format: Some(job.format.clone()),
                        passed: false,
                        message: error.to_string(),
                    },
                };
                trace!(
                    index = verdict.index,
                    patch_count,
                    format = job.format,
                    passed = verdict.passed,
                    "independent patch verdict"
                );
                Ok(verdict)
            };

        let capability = ThreadCapability::parallel(Some(ready_jobs.len().max(1)));
        let planned = context.plan_threads(capability.clone());
        let computed = if !ready_jobs.is_empty() {
            self.emit_running(
                OperationLabel {
                    command: "patch-validate",
                    family: OperationFamily::Patch,
                    format: None,
                },
                "validate",
                format!("validating {patch_count} patch(es) independently"),
                None,
                None,
            );
            if planned.used_parallelism {
                let (execution, pool) = match context.build_pool(capability) {
                    Ok(built) => built,
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            context.single_thread_execution(),
                        );
                    }
                };
                trace!(
                    used_parallelism = execution.used_parallelism,
                    threads = execution.effective_threads,
                    jobs = ready_jobs.len(),
                    "independent patch validation fan-out (parallel)"
                );
                pool.install(|| {
                    ready_jobs
                        .par_iter()
                        .map(run_one)
                        .collect::<std::result::Result<Vec<_>, _>>()
                })
            } else {
                trace!(
                    used_parallelism = false,
                    jobs = ready_jobs.len(),
                    "independent patch validation fan-out (serial)"
                );
                ready_jobs
                    .iter()
                    .map(run_one)
                    .collect::<std::result::Result<Vec<_>, _>>()
            }
        } else {
            Ok(Vec::new())
        };

        let computed = match computed {
            Ok(verdicts) => verdicts,
            // A genuine cancellation aborts the whole batch as a hard failure so the webapp maps the
            // call to a retryable "unknown" rather than reading partial per-patch verdicts.
            Err(error) => {
                debug!("independent patch validation cancelled");
                return OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    error.to_string(),
                    Some(planned),
                );
            }
        };

        let mut verdicts = decided;
        verdicts.extend(computed);
        verdicts.sort_by_key(|verdict| verdict.index);

        let passed_count = verdicts.iter().filter(|verdict| verdict.passed).count();
        let failed_count = patch_count.saturating_sub(passed_count);
        let status = if failed_count == 0 { "passed" } else { "mixed" };

        let mut formats: Vec<String> = Vec::new();
        for verdict in &verdicts {
            if let Some(format) = &verdict.format
                && !formats.iter().any(|existing| existing == format)
            {
                formats.push(format.clone());
            }
        }

        let IndependentValidationSummary {
            extracted_archives,
            n64_byte_order,
            extracted_patch_notes,
            mut validation_labels,
            min_size,
            expected_size,
            expected_input_checksums,
        } = summary;
        if extracted_archives > 0 {
            validation_labels.push(format!(
                "input resolved via {extracted_archives} container extract step(s)"
            ));
        }
        if let Some(mode) = n64_byte_order {
            validation_labels.push(format!("n64_byte_order={}", mode.id()));
        }
        validation_labels.extend(extracted_patch_notes);

        let format_label = if formats.is_empty() {
            "patch".to_string()
        } else {
            formats.join(", ")
        };
        let suffix = if validation_labels.is_empty() {
            String::new()
        } else {
            format!("; {}", validation_labels.join("; "))
        };
        let per_patch = verdicts
            .iter()
            .map(|verdict| {
                json!({
                    "index": verdict.index,
                    "patch": verdict.patch,
                    "format": verdict.format,
                    "status": if verdict.passed { "passed" } else { "failed" },
                    "message": verdict.message,
                })
            })
            .collect::<Vec<_>>();

        let mut report = OperationReport::succeeded(
            OperationFamily::Patch,
            formats.first().cloned(),
            "validate",
            format!(
                "independent patch validation {status}: {passed_count}/{patch_count} passed ({format_label}){suffix}"
            ),
            Some(100.0),
            Some(planned),
        );
        report.details = Some(json!({
            "patch_validation": {
                "dry_run": true,
                "independent": true,
                "status": status,
                "patch_count": patch_count,
                "passed_count": passed_count,
                "failed_count": failed_count,
                "format": formats.first().cloned(),
                "formats": formats,
                "per_patch": per_patch,
                "source_values": {
                    "minimum_size": min_size,
                    "size": expected_size,
                    "checksums": expected_input_checksums,
                },
            }
        }));
        report
    }
}

/// Shared input-level context threaded into independent-mode validation: the
/// notes/labels already accumulated by the shared input preparation plus the
/// expected source values, so the independent report carries the same suffix and
/// `source_values` block the chained report does.
struct IndependentValidationSummary {
    extracted_archives: usize,
    n64_byte_order: Option<PatchN64ByteOrderMode>,
    extracted_patch_notes: Vec<String>,
    validation_labels: Vec<String>,
    min_size: Option<u64>,
    expected_size: Option<u64>,
    expected_input_checksums: BTreeMap<String, String>,
}

/// A patch whose handler resolved and supports dry-run apply, queued for the
/// parallel independent validation fan-out.
struct IndependentReadyJob {
    index: usize,
    patch: String,
    resolved: PathBuf,
    format: String,
    handler: Arc<dyn rom_weaver_core::PatchHandler>,
}

/// One patch's independent-mode verdict, collected regardless of pass/fail.
struct PerPatchVerdict {
    index: usize,
    patch: String,
    format: Option<String>,
    passed: bool,
    message: String,
}
