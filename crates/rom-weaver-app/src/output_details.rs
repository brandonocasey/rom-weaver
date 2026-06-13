use super::*;

pub(super) const EMITTED_ARCHIVE_EXTENSIONS: &[&str] = &[
    ".7z", ".zip", ".zipx", ".tar", ".tgz", ".tar.gz", ".tbz2", ".tar.bz2", ".txz", ".tar.xz",
    ".zst", ".zstd", ".gz", ".bz2", ".xz", ".chd", ".rvz", ".gcz", ".wbfs", ".wia", ".cso",
    ".ciso", ".rar", ".pbp", ".z3d", ".z3ds",
];
pub(super) const EMITTED_ROM_EXTENSIONS: &[&str] = &[
    ".iso", ".img", ".bin", ".gdi", ".nds", ".dsi", ".srl", ".gba", ".3ds", ".3dsx", ".app",
    ".cci", ".cia", ".cxi", ".n64", ".z64", ".v64", ".nes", ".fds", ".sfc", ".smc", ".gen", ".md",
    ".gb", ".gbc", ".pce", ".a78", ".lnx", ".msx",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct FileSnapshot {
    size_bytes: u64,
    modified_unix_nanos: Option<u128>,
}

impl CliApp {
    pub(super) fn snapshot_file_tree(root: &Path) -> Result<HashMap<PathBuf, FileSnapshot>> {
        if !root.exists() {
            return Ok(HashMap::new());
        }

        if root.is_file() {
            let mut snapshot = HashMap::new();
            snapshot.insert(root.to_path_buf(), Self::file_snapshot_for_path(root)?);
            return Ok(snapshot);
        }
        if !root.is_dir() {
            return Ok(HashMap::new());
        }

        let mut snapshot = HashMap::new();
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            let mut entries =
                fs::read_dir(&directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.path());

            for entry in entries {
                let path = entry.path();
                let file_type = entry.file_type()?;
                if file_type.is_dir() {
                    directories.push(path);
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }
                snapshot.insert(path.clone(), Self::file_snapshot_for_path(&path)?);
            }
        }
        Ok(snapshot)
    }

    pub(super) fn file_snapshot_for_path(path: &Path) -> Result<FileSnapshot> {
        let metadata = fs::metadata(path)?;
        let modified_unix_nanos = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos());
        Ok(FileSnapshot {
            size_bytes: metadata.len(),
            modified_unix_nanos,
        })
    }

    pub(super) fn collect_changed_files(
        root: &Path,
        baseline: &HashMap<PathBuf, FileSnapshot>,
    ) -> Result<Vec<PathBuf>> {
        let after = Self::snapshot_file_tree(root)?;
        let mut changed = after
            .into_iter()
            .filter_map(|(path, snapshot)| match baseline.get(&path) {
                Some(previous) if previous == &snapshot => None,
                _ => Some(path),
            })
            .collect::<Vec<_>>();
        changed.sort();
        Ok(changed)
    }

    pub(super) fn attach_emitted_files_details(
        report: OperationReport,
        emitted_files: Vec<PathBuf>,
        default_kind: Option<&str>,
    ) -> OperationReport {
        if report.status != OperationStatus::Succeeded {
            return report;
        }
        let emitted = Self::build_emitted_file_detail_values(
            report.details.as_ref(),
            &emitted_files,
            default_kind,
        );
        Self::set_emitted_files_detail(report, emitted)
    }

    /// Builds the `emitted_files` detail objects for the given paths, merging in any checksum (or
    /// other) fields already present for the same path in `report_details`. Used both by the
    /// single-level attach and by the nested descent, which captures each level's outputs.
    pub(super) fn build_emitted_file_detail_values(
        report_details: Option<&Value>,
        emitted_files: &[PathBuf],
        default_kind: Option<&str>,
    ) -> Vec<Value> {
        let existing = match report_details {
            Some(Value::Object(map)) => match map.get("emitted_files") {
                Some(Value::Array(entries)) => entries
                    .iter()
                    .filter_map(|entry| match entry {
                        Value::Object(map) => {
                            let key = Self::emitted_file_detail_key(map)?;
                            Some((key, map.clone()))
                        }
                        _ => None,
                    })
                    .collect::<BTreeMap<_, _>>(),
                _ => BTreeMap::new(),
            },
            _ => BTreeMap::new(),
        };
        emitted_files
            .iter()
            .filter_map(|path| {
                let mut detail = match Self::build_emitted_file_detail(path, default_kind)? {
                    Value::Object(map) => map,
                    _ => return None,
                };
                if let Some(extra) = existing.get(&Self::normalized_emitted_path_key(path)) {
                    for (key, value) in extra {
                        detail.entry(key.clone()).or_insert_with(|| value.clone());
                    }
                }
                Some(Value::Object(detail))
            })
            .collect::<Vec<_>>()
    }

    pub(super) fn build_or_existing_emitted_file_detail_values(
        report_details: Option<&Value>,
        emitted_files: &[PathBuf],
        default_kind: Option<&str>,
    ) -> Vec<Value> {
        let emitted =
            Self::build_emitted_file_detail_values(report_details, emitted_files, default_kind);
        if emitted.is_empty() {
            Self::existing_emitted_file_detail_values(report_details)
        } else {
            emitted
        }
    }

    pub(super) fn existing_emitted_file_detail_values(
        report_details: Option<&Value>,
    ) -> Vec<Value> {
        match report_details {
            Some(Value::Object(map)) => match map.get("emitted_files") {
                Some(Value::Array(entries)) => entries
                    .iter()
                    .filter_map(|entry| match entry {
                        Value::Object(map) if Self::emitted_file_detail_key(map).is_some() => {
                            Some(entry.clone())
                        }
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// Union the change-detection scan results with the paths the handler reported it extracted,
    /// de-duplicating and sorting. The scan compares `(size, mtime)` against a pre-extract baseline
    /// to infer what was written, but misses a re-extracted file whose snapshot matches a
    /// pre-existing baseline entry — e.g. on the browser's OPFS, which does not bump mtime on
    /// rewrite, so a disc `.cue` sheet a prior probe already left in the shared out dir is dropped.
    /// Any path the handler explicitly reports was written by this extract, so it is added back.
    pub(super) fn merge_scanned_and_reported_emitted_files(
        mut scanned: Vec<PathBuf>,
        reported: Vec<PathBuf>,
    ) -> Vec<PathBuf> {
        for path in reported {
            if !scanned.contains(&path) {
                scanned.push(path);
            }
        }
        scanned.sort();
        scanned.dedup();
        scanned
    }

    pub(super) fn emitted_file_detail_paths(report_details: Option<&Value>) -> Vec<PathBuf> {
        match report_details {
            Some(Value::Object(map)) => match map.get("emitted_files") {
                Some(Value::Array(entries)) => entries
                    .iter()
                    .filter_map(|entry| match entry {
                        Value::Object(map) => map.get("path").and_then(Value::as_str),
                        _ => None,
                    })
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .map(PathBuf::from)
                    .collect(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// Replaces the report's `emitted_files` detail with the given pre-built objects, preserving any
    /// other detail keys already present.
    pub(super) fn set_emitted_files_detail(
        mut report: OperationReport,
        emitted: Vec<Value>,
    ) -> OperationReport {
        let mut details = match report.details.take() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        details.insert("emitted_files".to_string(), Value::Array(emitted));
        report.details = Some(Value::Object(details));
        report
    }

    pub(super) fn emitted_file_detail_key(entry: &Map<String, Value>) -> Option<String> {
        entry
            .get("path")
            .and_then(Value::as_str)
            .map(Self::normalize_emitted_path_string)
    }

    pub(super) fn normalized_emitted_path_key(path: &Path) -> String {
        let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        Self::normalize_emitted_path_string(&canonical.to_string_lossy())
    }

    pub(super) fn normalize_emitted_path_string(path: &str) -> String {
        path.replace('\\', "/")
    }

    pub(super) fn build_emitted_file_detail(
        path: &Path,
        default_kind: Option<&str>,
    ) -> Option<Value> {
        let metadata = fs::metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }

        let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let file_name = canonical.file_name()?.to_string_lossy().into_owned();
        let mut entry = Map::new();
        entry.insert(
            "path".to_string(),
            json!(canonical.to_string_lossy().replace('\\', "/")),
        );
        entry.insert("file_name".to_string(), json!(file_name));
        entry.insert("size_bytes".to_string(), json!(metadata.len()));
        if let Some(kind) = Self::infer_emitted_file_kind(&canonical).or(default_kind) {
            entry.insert("kind".to_string(), json!(kind));
        }
        Some(Value::Object(entry))
    }

    pub(super) fn infer_emitted_file_kind(path: &Path) -> Option<&'static str> {
        let file_name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
        if file_name.ends_with(".cue") {
            return Some("cue");
        }
        if file_name.ends_with(".bin") {
            return Some("bin");
        }
        if EMITTED_ARCHIVE_EXTENSIONS
            .iter()
            .any(|extension| file_name.ends_with(extension))
        {
            return Some("archive");
        }
        if EMITTED_ROM_EXTENSIONS
            .iter()
            .any(|extension| file_name.ends_with(extension))
        {
            return Some("rom");
        }
        None
    }
}

#[cfg(test)]
mod emitted_files_merge_tests {
    use std::path::PathBuf;

    use super::CliApp;

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn reported_only_files_are_unioned_back_in() {
        // The change-detection scan missed the re-extracted `disc.cue` (its OPFS snapshot matched a
        // probe-left baseline entry), but the handler reported it. The merge must restore it so the
        // disc arrives complete (sheet + tracks) rather than as bare, ungrouped tracks.
        let scanned = paths(&["/work/track01.bin", "/work/track02.bin"]);
        let reported = paths(&["/work/disc.cue", "/work/track01.bin", "/work/track02.bin"]);
        let merged = CliApp::merge_scanned_and_reported_emitted_files(scanned, reported);
        assert_eq!(
            merged,
            paths(&["/work/disc.cue", "/work/track01.bin", "/work/track02.bin"])
        );
    }

    #[test]
    fn scan_only_files_are_preserved_and_deduped() {
        // A scan that already captured every file (the native filesystem case) is unchanged: the
        // reported set is a subset, so the union is a no-op apart from sorting.
        let scanned = paths(&["/work/b.bin", "/work/a.bin"]);
        let reported = paths(&["/work/a.bin"]);
        let merged = CliApp::merge_scanned_and_reported_emitted_files(scanned, reported);
        assert_eq!(merged, paths(&["/work/a.bin", "/work/b.bin"]));
    }

    #[test]
    fn empty_scan_falls_back_to_reported() {
        let merged =
            CliApp::merge_scanned_and_reported_emitted_files(Vec::new(), paths(&["/work/rom.nes"]));
        assert_eq!(merged, paths(&["/work/rom.nes"]));
    }
}
