//! `manifest create`: build, validate, and emit an rw.json manifest from
//! local sources (native + wasm; the webapp export drives this command).

use flate2::{Compression as GzCompression, write::GzEncoder};

use super::manifest_parse::{manifest_file_name_codec, parse_manifest_bytes};
use super::*;

const MANIFEST_CREATE_DEFAULT_ALGORITHMS: [&str; 3] = ["crc32", "md5", "sha1"];

/// The result of one `manifest create`, returned under
/// `details.manifest_create`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct ManifestCreateResult {
    pub manifest_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub bundle_path: Option<String>,
    /// The canonical manifest as written (checksums computed and normalized).
    pub manifest: RomWeaverManifest,
    pub warnings: Vec<String>,
}

impl CliApp {
    pub(super) fn run_manifest_create(&self, args: ManifestCreateCommand) -> AppRunOutcome {
        trace!(
            rom = ?args.rom,
            rom_url = ?args.rom_url,
            patches = args.patch.len(),
            output = %args.output.display(),
            bundle = ?args.bundle,
            checksum_algorithms = args.checksum.len(),
            threads = %args.threads,
            "starting manifest create command"
        );
        let context = self.context(args.threads);
        let thread_execution = context.single_thread_execution();
        let report = match self.manifest_create_inner(&args, &context) {
            Ok(result) => {
                let label = format!(
                    "wrote manifest `{}` ({} patch entr{}{})",
                    result.manifest_path,
                    result.manifest.patches.len(),
                    if result.manifest.patches.len() == 1 {
                        "y"
                    } else {
                        "ies"
                    },
                    result
                        .bundle_path
                        .as_deref()
                        .map(|bundle| format!("; bundled into `{bundle}`"))
                        .unwrap_or_default(),
                );
                let mut report = OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("manifest-create".to_string()),
                    "manifest-create",
                    label,
                    Some(100.0),
                    thread_execution.clone(),
                );
                match serde_json::to_value(&result) {
                    Ok(value) => {
                        report.details = Some(json!({ "manifest_create": value }));
                        report
                    }
                    Err(error) => OperationReport::failed(
                        OperationFamily::Command,
                        Some("manifest-create".to_string()),
                        "manifest-create",
                        format!("failed to serialize manifest create result: {error}"),
                        thread_execution,
                    ),
                }
            }
            Err(error) => OperationReport::failed(
                OperationFamily::Command,
                Some("manifest-create".to_string()),
                "manifest-create",
                error.to_string(),
                thread_execution,
            ),
        };
        self.finish("manifest-create", report)
    }

    fn manifest_create_inner(
        &self,
        args: &ManifestCreateCommand,
        context: &OperationContext,
    ) -> Result<ManifestCreateResult> {
        let specs = manifest_create_patch_specs(args)?;
        if specs.is_empty() {
            return Err(RomWeaverError::Validation(
                "manifest create requires at least one --patch".to_string(),
            ));
        }
        let algorithms: Vec<String> = if args.checksum.is_empty() {
            MANIFEST_CREATE_DEFAULT_ALGORITHMS
                .iter()
                .map(|algorithm| (*algorithm).to_string())
                .collect()
        } else {
            args.checksum
                .iter()
                .map(|algorithm| algorithm.to_ascii_lowercase())
                .collect()
        };
        if let Some(invalid) = algorithms.iter().find(|algorithm| {
            !supported_algorithms()
                .iter()
                .any(|supported| supported.eq_ignore_ascii_case(algorithm))
        }) {
            return Err(RomWeaverError::Validation(format!(
                "unsupported checksum algorithm `{invalid}`"
            )));
        }
        let algorithm_refs: Vec<&str> = algorithms.iter().map(String::as_str).collect();
        let mut warnings = Vec::new();

        let rom = match (&args.rom, &args.rom_url) {
            (None, None) => {
                if args.rom_name.is_some() {
                    warnings.push("--rom-name ignored: no rom source given".to_string());
                }
                None
            }
            (Some(path), url_override) => {
                if !path.is_file() {
                    return Err(RomWeaverError::Validation(format!(
                        "rom path does not exist: `{}`",
                        path.display()
                    )));
                }
                let checksums = checksum_file_values(path, &algorithm_refs, context)?;
                let size = fs::metadata(path)?.len();
                let base_name = required_base_name(path, "rom")?;
                Some(ManifestRom {
                    name: args.rom_name.clone(),
                    url: url_override.clone(),
                    path: url_override.is_none().then_some(base_name),
                    checks: Some(ManifestChecks {
                        checksums,
                        size: Some(size),
                    }),
                })
            }
            (None, Some(url)) => Some(ManifestRom {
                name: args.rom_name.clone(),
                url: Some(url.clone()),
                path: None,
                checks: None,
            }),
        };

        let mut patches = Vec::with_capacity(specs.len());
        for spec in &specs {
            if !spec.path.is_file() {
                return Err(RomWeaverError::Validation(format!(
                    "patch path does not exist: `{}`",
                    spec.path.display()
                )));
            }
            let integrity = checksum_file_values(&spec.path, &algorithm_refs, context)?;
            let base_name = required_base_name(&spec.path, "patch")?;
            patches.push(ManifestPatchEntry {
                name: spec.name.clone(),
                description: spec.description.clone(),
                status: spec.status.unwrap_or_default(),
                label: spec.label.clone(),
                url: spec.source_url.clone(),
                path: spec.source_url.is_none().then_some(base_name),
                checks: None,
                integrity,
                header: spec.header,
            });
        }

        // Path entries reference files by base name (next to the manifest, or
        // as flat bundle members) — duplicates would alias each other.
        let mut seen_names = BTreeSet::new();
        let path_names = rom
            .iter()
            .filter_map(|rom| rom.path.clone())
            .chain(patches.iter().filter_map(|patch| patch.path.clone()));
        for name in path_names {
            if !seen_names.insert(name.clone()) {
                return Err(RomWeaverError::Validation(format!(
                    "duplicate source file name `{name}`; manifest path entries reference files by name, so rename one of the inputs"
                )));
            }
        }

        let compress = if args.no_compress {
            Some(ManifestCompress::Disabled(false))
        } else if args.compress_format.is_some()
            || !args.compress_codec.is_empty()
            || args.compress_level.is_some()
        {
            Some(ManifestCompress::Settings(ManifestCompressSettings {
                format: args.compress_format.clone(),
                codecs: args.compress_codec.clone(),
                level: args.compress_level,
            }))
        } else {
            None
        };
        let output =
            (args.output_name.is_some() || args.output_header.is_some() || compress.is_some())
                .then(|| ManifestOutput {
                    name: args.output_name.clone(),
                    header: args.output_header,
                    compress,
                });

        let manifest = RomWeaverManifest {
            version: MANIFEST_VERSION,
            name: args.name.clone(),
            description: args.description.clone(),
            rom,
            patches,
            output,
        };
        let mut bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| {
            RomWeaverError::Validation(format!("failed to serialize manifest: {error}"))
        })?;
        bytes.push(b'\n');
        // Round-trip validation: create can never emit what parse rejects.
        parse_manifest_bytes(&bytes)?;

        let output_base_name = args
            .output
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if manifest_file_name_codec(output_base_name).is_none() {
            warnings.push(format!(
                "manifest written as `{output_base_name}`: apply auto-detection only recognizes rw.json / rw.json.<codec> names"
            ));
        }
        write_manifest_bytes(&args.output, &bytes)?;
        trace!(output = %args.output.display(), bytes = bytes.len(), "manifest written");

        let bundle_path = match &args.bundle {
            Some(bundle) => Some(self.create_manifest_bundle(
                bundle,
                &bytes,
                args.rom.as_deref().filter(|_| args.rom_url.is_none()),
                &specs,
                context,
            )?),
            None => None,
        };

        Ok(ManifestCreateResult {
            manifest_path: Self::normalize_emitted_path_string(&args.output.to_string_lossy()),
            bundle_path: bundle_path
                .map(|path| Self::normalize_emitted_path_string(&path.to_string_lossy())),
            manifest,
            warnings,
        })
    }

    /// Stage `rw.json` + the local sources flat into a temp dir and pack them
    /// with the requested creatable container format.
    fn create_manifest_bundle(
        &self,
        bundle: &Path,
        manifest_bytes: &[u8],
        rom: Option<&Path>,
        specs: &[ManifestCreatePatchSpec],
        context: &OperationContext,
    ) -> Result<PathBuf> {
        let staging = context.temp_paths().next_path("manifest-bundle", None);
        fs::create_dir_all(&staging)?;
        let manifest_path = staging.join("rw.json");
        fs::write(&manifest_path, manifest_bytes)?;
        let mut inputs = vec![manifest_path];
        if let Some(rom) = rom {
            let target = staging.join(required_base_name(rom, "rom")?);
            fs::copy(rom, &target)?;
            inputs.push(target);
        }
        for spec in specs {
            if spec.source_url.is_some() {
                continue;
            }
            let target = staging.join(required_base_name(&spec.path, "patch")?);
            fs::copy(&spec.path, &target)?;
            inputs.push(target);
        }
        let format = bundle
            .extension()
            .and_then(|extension| extension.to_str())
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "--bundle path needs a creatable archive extension (for example .zip)"
                        .to_string(),
                )
            })?;
        let handler = self.containers.find_creatable_by_name(format)?;
        trace!(
            bundle = %bundle.display(),
            format = handler.descriptor().name,
            inputs = inputs.len(),
            "creating manifest bundle archive"
        );
        let request = ContainerCreateRequest {
            inputs,
            output: bundle.to_path_buf(),
            format: handler.descriptor().name.to_string(),
            codec: None,
            level: None,
            parent: None,
        };
        handler.create(&request, context)?;
        Ok(bundle.to_path_buf())
    }
}

/// Normalize per-patch specs for the wasm JSON path: metadata vectors must be
/// index-aligned with `patch` (same length) or omitted entirely.
fn manifest_create_patch_specs(
    args: &ManifestCreateCommand,
) -> Result<Vec<ManifestCreatePatchSpec>> {
    if !args.patch_specs.is_empty() {
        return Ok(args.patch_specs.clone());
    }
    let count = args.patch.len();
    let names = aligned_metadata(&args.patch_name, count, "--patch-name")?;
    let descriptions = aligned_metadata(&args.patch_description, count, "--patch-description")?;
    let labels = aligned_metadata(&args.patch_label, count, "--patch-label")?;
    let statuses = aligned_metadata(&args.patch_status, count, "--patch-status")?;
    let source_urls = aligned_metadata(&args.patch_source_url, count, "--patch-source-url")?;
    let headers = aligned_metadata(&args.patch_header, count, "--patch-header")?;
    Ok(args
        .patch
        .iter()
        .enumerate()
        .map(|(index, path)| ManifestCreatePatchSpec {
            path: path.clone(),
            name: names[index].clone(),
            description: descriptions[index].clone(),
            label: labels[index].clone(),
            status: statuses[index],
            source_url: source_urls[index].clone(),
            header: headers[index],
        })
        .collect())
}

fn aligned_metadata<T: Clone>(values: &[T], count: usize, flag: &str) -> Result<Vec<Option<T>>> {
    if values.is_empty() {
        return Ok(vec![None; count]);
    }
    if values.len() == count {
        return Ok(values.iter().cloned().map(Some).collect());
    }
    Err(RomWeaverError::Validation(format!(
        "{flag} must be given once per --patch (or not at all); got {} value(s) for {count} patch(es)",
        values.len()
    )))
}

fn required_base_name(path: &Path, what: &str) -> Result<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "{what} path has no usable file name: `{}`",
                path.display()
            ))
        })
}

/// Write manifest bytes honoring the output name's codec extension: plain
/// JSON, `.gz`, or `.zst` (parse additionally reads `.bz2`/`.xz`, but create
/// keeps to the two codecs with in-tree encoders).
fn write_manifest_bytes(output: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    let base_name = output
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let codec = manifest_file_name_codec(base_name).flatten().or_else(|| {
        // A non-rw.json name still honors a trailing codec extension.
        base_name.rsplit_once('.').map(|(_, extension)| extension)
    });
    match codec {
        Some(extension) if extension.eq_ignore_ascii_case("gz") => {
            let file = File::create(output)?;
            let mut encoder = GzEncoder::new(file, GzCompression::best());
            encoder.write_all(bytes)?;
            encoder.finish()?;
            Ok(())
        }
        Some(extension) if extension.eq_ignore_ascii_case("zst") => {
            let file = File::create(output)?;
            zstd::stream::copy_encode(bytes, file, 19).map_err(|error| {
                RomWeaverError::Validation(format!("zstd manifest encoding failed: {error}"))
            })?;
            Ok(())
        }
        Some(extension)
            if extension.eq_ignore_ascii_case("bz2") || extension.eq_ignore_ascii_case("xz") =>
        {
            Err(RomWeaverError::Validation(format!(
                "manifest create emits .gz or .zst compressed manifests; `.{extension}` is read-only"
            )))
        }
        _ => {
            fs::write(output, bytes)?;
            Ok(())
        }
    }
}
