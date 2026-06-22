use super::*;
use rom_weaver_core::parse_disc_sheet_refs_from_text;

/// One container entry the host hands to `group-disc-entries`. Mirrors the listing record the
/// webapp already has in hand (`filename` + the coarse `archive_entry_type`), plus the raw sheet
/// `text` for a `.cue`/`.gdi` so Rust parses the references instead of the host re-parsing them.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct DiscGroupingEntry {
    /// Entry name exactly as listed (may include a directory prefix).
    pub filename: String,
    /// Coarse archive entry type when known (`cue`/`gdi`/`track`/…). Only used to decide whether a
    /// sheet anchors a *synthetic* track group (its sibling tracks) versus a parsed-reference group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub archive_entry_type: Option<String>,
    /// Raw `.cue`/`.gdi` text, when the host already extracted the sheet bytes. Absent for non-sheet
    /// entries; absent for a sheet the host could not read (treated as an unreadable sheet).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub sheet_text: Option<String>,
}

/// A `.cue`/`.gdi` disc group: its sheet plus the track files it references, with any unresolved
/// references called out. Carries the same fields the webapp's `CompressionRomCueGroup` exposed.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct DiscGroup {
    /// The sheet entry name (`.cue`/`.gdi`).
    pub cue_file_name: String,
    /// Resolved track entry names referenced by the sheet, in declaration order.
    pub track_file_names: Vec<String>,
    /// Referenced names the sheet declared that did not resolve to a listed entry (or a sentinel
    /// message for an unreadable sheet).
    pub missing_references: Vec<String>,
    /// `true` when the group has no missing references and at least one non-sheet track — the
    /// "complete disc" predicate the auto-pick uses.
    pub complete: bool,
    /// The sheet text echoed back for a cue sheet (when supplied), so the host need not re-read it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub cue_text: Option<String>,
}

/// What the host should select when no explicit selection was given. `entry_name` is the single
/// auto-pick (a complete disc's sheet, or a lone standalone/rom entry); `ambiguous` is set when
/// multiple competing candidates remain and the host must prompt.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct DiscAutoPick {
    /// The entry name to auto-select, or `null` when there is nothing to pick / the source is
    /// ambiguous.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional, as = "Option<_>"))]
    pub entry_name: Option<String>,
    /// `true` when multiple input candidates compete and the host must prompt the user to keep one.
    pub ambiguous: bool,
}

/// The consolidated disc-grouping decision for one source's entry list: the deduplicated disc
/// groups, the standalone (non-disc, non-track) entries, and the auto-pick recommendation. Replaces
/// the webapp's CUE re-parse + track-set dedup + auto-pick decision tree.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
pub struct DiscGroupingResult {
    /// Deduplicated disc groups (sheets covering an identical track set collapse to one).
    pub disc_groups: Vec<DiscGroup>,
    /// Track entry names referenced by some disc group (so the host can mark them as members).
    pub referenced_track_names: Vec<String>,
    /// Entries that are neither a sheet, nor a referenced track — each a standalone ROM candidate.
    pub standalone_entries: Vec<String>,
    /// Auto-pick recommendation when no explicit selection was given.
    pub auto_pick: DiscAutoPick,
}

fn base_file_name(name: &str) -> &str {
    name.rsplit(['/', '\\']).next().unwrap_or(name)
}

fn directory_of(name: &str) -> &str {
    match name.rfind(['/', '\\']) {
        Some(index) => &name[..index],
        None => "",
    }
}

fn is_cue_name(name: &str) -> bool {
    base_file_name(name).to_ascii_lowercase().ends_with(".cue")
}

fn is_gdi_name(name: &str) -> bool {
    base_file_name(name).to_ascii_lowercase().ends_with(".gdi")
}

fn is_sheet_name(name: &str) -> bool {
    is_cue_name(name) || is_gdi_name(name)
}

impl CliApp {
    pub(super) fn run_group_disc_entries(&self, args: GroupDiscEntriesCommand) -> AppRunOutcome {
        let GroupDiscEntriesCommand {
            source_name,
            entries,
        } = args;
        trace!(
            source = %source_name,
            entry_count = entries.len(),
            "starting group-disc-entries command"
        );
        let result = Self::group_disc_entries(&entries);
        trace!(
            source = %source_name,
            disc_groups = result.disc_groups.len(),
            standalones = result.standalone_entries.len(),
            auto_pick = ?result.auto_pick.entry_name,
            ambiguous = result.auto_pick.ambiguous,
            "computed disc grouping"
        );
        let context = self.context(ThreadBudget::Fixed(1));
        let label = format!(
            "grouped {} entr(ies) of `{source_name}` into {} disc group(s); {}",
            entries.len(),
            result.disc_groups.len(),
            match (&result.auto_pick.entry_name, result.auto_pick.ambiguous) {
                (Some(name), _) => format!("auto-pick `{name}`"),
                (None, true) => "ambiguous (prompt)".to_string(),
                (None, false) => "nothing to pick".to_string(),
            }
        );
        let mut report = OperationReport::succeeded(
            OperationFamily::Command,
            Some("group-disc-entries".to_string()),
            "group-disc-entries",
            label,
            Some(100.0),
            context.single_thread_execution(),
        );
        match serde_json::to_value(&result) {
            Ok(value) => report.details = Some(json!({ "disc_grouping": value })),
            Err(error) => {
                return self.finish(
                    "group-disc-entries",
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("group-disc-entries".to_string()),
                        "group-disc-entries",
                        format!("failed to serialize disc grouping result: {error}"),
                        context.single_thread_execution(),
                    ),
                );
            }
        }
        self.finish("group-disc-entries", report)
    }

    /// Group a source's entry list into discs + standalones and compute the auto-pick — the pure
    /// decision the webapp previously re-implemented (CUE re-parse, track-set dedup, auto-pick tree).
    /// No I/O: cue/gdi references come from the supplied `sheet_text` (the host extracted it) or, for
    /// a sheet with sibling `track` entries, from those siblings.
    pub(super) fn group_disc_entries(entries: &[DiscGroupingEntry]) -> DiscGroupingResult {
        let mut groups: Vec<DiscGroup> = Vec::new();
        let mut referenced: Vec<String> = Vec::new();
        let mut referenced_seen: HashSet<String> = HashSet::new();
        let mut push_referenced = |name: &str, referenced: &mut Vec<String>| {
            if referenced_seen.insert(name.to_string()) {
                referenced.push(name.to_string());
            }
        };

        for entry in entries {
            let cue_file_name = entry.filename.clone();
            if !is_sheet_name(&cue_file_name) {
                continue;
            }
            let entry_type = entry.archive_entry_type.as_deref().unwrap_or_default();
            // A synthetic disc group: a sheet entry typed `cue`/`gdi` whose tracks are the sibling
            // `track` entries in the same directory (the host never extracted/parsed the sheet).
            if entry_type == "cue" || entry_type == "gdi" {
                let sheet_dir = directory_of(&cue_file_name);
                let tracks: Vec<String> = entries
                    .iter()
                    .filter(|candidate| {
                        candidate.archive_entry_type.as_deref() == Some("track")
                            && !is_cue_name(&candidate.filename)
                            && !is_gdi_name(&candidate.filename)
                            && (sheet_dir.is_empty()
                                || directory_of(&candidate.filename) == sheet_dir)
                    })
                    .map(|candidate| candidate.filename.clone())
                    .collect();
                if !tracks.is_empty() {
                    for track in &tracks {
                        push_referenced(track, &mut referenced);
                    }
                    groups.push(DiscGroup {
                        complete: Self::disc_group_is_complete(&tracks, &[]),
                        cue_file_name,
                        track_file_names: tracks,
                        missing_references: Vec::new(),
                        cue_text: None,
                    });
                    continue;
                }
            }
            // Only a `.cue` whose text the host supplied is parsed for references; a `.gdi` without
            // sibling tracks is left for standalone handling rather than mis-parsed.
            if !is_cue_name(&cue_file_name) {
                continue;
            }
            let Some(text) = entry.sheet_text.as_deref() else {
                // Sheet present but unreadable (host could not extract it): mark missing, no tracks.
                groups.push(DiscGroup {
                    complete: false,
                    cue_file_name,
                    track_file_names: Vec::new(),
                    missing_references: vec!["Invalid or unreadable CUE".to_string()],
                    cue_text: None,
                });
                continue;
            };
            match parse_disc_sheet_refs_from_text(DiscSheetKind::Cue, text, &cue_file_name) {
                Ok(references) => {
                    let mut track_file_names = Vec::new();
                    let mut missing_references = Vec::new();
                    for reference in &references {
                        match Self::resolve_reference_entry(entries, &cue_file_name, reference) {
                            Some(resolved) => {
                                push_referenced(&resolved, &mut referenced);
                                track_file_names.push(resolved);
                            }
                            None => missing_references.push(reference.clone()),
                        }
                    }
                    groups.push(DiscGroup {
                        complete: Self::disc_group_is_complete(
                            &track_file_names,
                            &missing_references,
                        ),
                        cue_file_name,
                        track_file_names,
                        missing_references,
                        cue_text: Some(text.to_string()),
                    });
                }
                Err(_) => groups.push(DiscGroup {
                    complete: false,
                    cue_file_name,
                    track_file_names: Vec::new(),
                    missing_references: vec!["Invalid or unreadable CUE".to_string()],
                    cue_text: None,
                }),
            }
        }

        // A single disc can ship a `.cue` AND a `.gdi` describing the same tracks; collapse sheets
        // covering an identical track set into one disc group so the disc is not double-counted.
        let mut deduped: Vec<DiscGroup> = Vec::new();
        let mut seen_track_sets: HashSet<String> = HashSet::new();
        for group in groups {
            let key = Self::track_set_key(&group.track_file_names);
            if !key.is_empty() && !seen_track_sets.insert(key) {
                continue;
            }
            deduped.push(group);
        }

        let standalone_entries: Vec<String> = entries
            .iter()
            .map(|entry| entry.filename.clone())
            .filter(|name| {
                !(is_cue_name(name) || is_gdi_name(name) || referenced_seen.contains(name))
            })
            .collect();

        let auto_pick = Self::compute_disc_auto_pick(entries, &deduped, &standalone_entries);

        DiscGroupingResult {
            disc_groups: deduped,
            referenced_track_names: referenced,
            standalone_entries,
            auto_pick,
        }
    }

    /// A disc group is "complete" when nothing is missing and it has at least one non-sheet track —
    /// matching the webapp's `isCompleteCueGroup`.
    fn disc_group_is_complete(track_file_names: &[String], missing_references: &[String]) -> bool {
        missing_references.is_empty()
            && !track_file_names.is_empty()
            && track_file_names.iter().any(|name| !is_cue_name(name))
    }

    /// Resolve a sheet reference to a listed entry, matching the host's lookup: exact name, then
    /// basename, scoped to the sheet's directory when it has one.
    fn resolve_reference_entry(
        entries: &[DiscGroupingEntry],
        cue_file_name: &str,
        reference: &str,
    ) -> Option<String> {
        let reference_base = base_file_name(reference).to_ascii_lowercase();
        let sheet_dir = directory_of(cue_file_name);
        let mut basename_match: Option<String> = None;
        for entry in entries {
            if entry.filename == reference {
                return Some(entry.filename.clone());
            }
            if base_file_name(&entry.filename).to_ascii_lowercase() == reference_base {
                let same_dir = sheet_dir.is_empty() || directory_of(&entry.filename) == sheet_dir;
                if same_dir && basename_match.is_none() {
                    basename_match = Some(entry.filename.clone());
                }
            }
        }
        basename_match
    }

    fn track_set_key(track_file_names: &[String]) -> String {
        let mut sorted: Vec<&String> = track_file_names.iter().collect();
        sorted.sort();
        sorted
            .iter()
            .map(|name| name.as_str())
            .collect::<Vec<_>>()
            .join("\u{0}")
    }

    /// Compute the auto-pick: exactly one complete disc + zero standalones → that disc's sheet; zero
    /// complete discs + exactly one standalone → it; zero complete discs + exactly one rom entry →
    /// it; otherwise ambiguous (prompt). Mirrors `resolveCompressionRomAutoPickEntryName` with an
    /// empty explicit selection.
    fn compute_disc_auto_pick(
        entries: &[DiscGroupingEntry],
        disc_groups: &[DiscGroup],
        standalone_entries: &[String],
    ) -> DiscAutoPick {
        if entries.is_empty() {
            return DiscAutoPick {
                entry_name: None,
                ambiguous: false,
            };
        }
        let complete: Vec<&DiscGroup> = disc_groups.iter().filter(|group| group.complete).collect();
        if complete.len() == 1 && standalone_entries.is_empty() {
            return DiscAutoPick {
                entry_name: Some(complete[0].cue_file_name.clone()),
                ambiguous: false,
            };
        }
        if complete.is_empty() && standalone_entries.len() == 1 {
            return DiscAutoPick {
                entry_name: Some(standalone_entries[0].clone()),
                ambiguous: false,
            };
        }
        if complete.is_empty() && entries.len() == 1 {
            return DiscAutoPick {
                entry_name: Some(entries[0].filename.clone()),
                ambiguous: false,
            };
        }
        DiscAutoPick {
            entry_name: None,
            ambiguous: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, kind: Option<&str>, sheet_text: Option<&str>) -> DiscGroupingEntry {
        DiscGroupingEntry {
            filename: name.to_string(),
            archive_entry_type: kind.map(str::to_string),
            sheet_text: sheet_text.map(str::to_string),
        }
    }

    const TWO_TRACK_CUE: &str = concat!(
        "FILE \"Game (Track 1).bin\" BINARY\n",
        "  TRACK 01 MODE1/2352\n",
        "    INDEX 01 00:00:00\n",
        "FILE \"Game (Track 2).bin\" BINARY\n",
        "  TRACK 02 AUDIO\n",
        "    INDEX 01 00:02:00\n",
    );

    #[test]
    fn parsed_cue_groups_tracks_and_auto_picks_single_disc() {
        let entries = vec![
            entry("Game.cue", None, Some(TWO_TRACK_CUE)),
            entry("Game (Track 1).bin", None, None),
            entry("Game (Track 2).bin", None, None),
        ];
        let result = CliApp::group_disc_entries(&entries);
        assert_eq!(result.disc_groups.len(), 1);
        let group = &result.disc_groups[0];
        assert_eq!(group.cue_file_name, "Game.cue");
        assert_eq!(
            group.track_file_names,
            vec![
                "Game (Track 1).bin".to_string(),
                "Game (Track 2).bin".to_string()
            ]
        );
        assert!(group.missing_references.is_empty());
        assert!(group.complete);
        assert!(result.standalone_entries.is_empty());
        assert_eq!(result.auto_pick.entry_name.as_deref(), Some("Game.cue"));
        assert!(!result.auto_pick.ambiguous);
    }

    #[test]
    fn missing_track_reference_marks_group_incomplete() {
        let entries = vec![entry("Game.cue", None, Some(TWO_TRACK_CUE))];
        let result = CliApp::group_disc_entries(&entries);
        assert_eq!(result.disc_groups.len(), 1);
        let group = &result.disc_groups[0];
        assert!(group.track_file_names.is_empty());
        assert_eq!(group.missing_references.len(), 2);
        assert!(!group.complete);
        // No complete disc, no standalone, single entry → auto-pick the lone cue entry.
        assert_eq!(result.auto_pick.entry_name.as_deref(), Some("Game.cue"));
        assert!(!result.auto_pick.ambiguous);
    }

    #[test]
    fn unreadable_cue_without_text_is_incomplete() {
        let entries = vec![entry("Game.cue", None, None)];
        let result = CliApp::group_disc_entries(&entries);
        assert_eq!(result.disc_groups.len(), 1);
        assert_eq!(
            result.disc_groups[0].missing_references,
            vec!["Invalid or unreadable CUE".to_string()]
        );
        assert!(!result.disc_groups[0].complete);
    }

    #[test]
    fn synthetic_gdi_group_from_sibling_tracks() {
        let entries = vec![
            entry("Game.gdi", Some("gdi"), None),
            entry("track01.bin", Some("track"), None),
            entry("track02.raw", Some("track"), None),
        ];
        let result = CliApp::group_disc_entries(&entries);
        assert_eq!(result.disc_groups.len(), 1);
        let group = &result.disc_groups[0];
        assert_eq!(group.cue_file_name, "Game.gdi");
        assert_eq!(
            group.track_file_names,
            vec!["track01.bin".to_string(), "track02.raw".to_string()]
        );
        assert!(group.complete);
        assert!(result.standalone_entries.is_empty());
        assert_eq!(result.auto_pick.entry_name.as_deref(), Some("Game.gdi"));
    }

    #[test]
    fn cue_and_gdi_covering_same_tracks_dedupe() {
        // A `.gdi` (synthetic) and a `.cue` (parsed) cover the same two tracks; only one survives.
        let cue = concat!(
            "FILE \"track01.bin\" BINARY\n",
            "  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
            "FILE \"track02.raw\" BINARY\n",
            "  TRACK 02 AUDIO\n    INDEX 01 00:02:00\n",
        );
        let entries = vec![
            entry("track01.bin", Some("track"), None),
            entry("track02.raw", Some("track"), None),
            entry("Game.gdi", Some("gdi"), None),
            entry("Game.cue", None, Some(cue)),
        ];
        let result = CliApp::group_disc_entries(&entries);
        assert_eq!(result.disc_groups.len(), 1, "identical track sets collapse");
    }

    #[test]
    fn single_standalone_rom_auto_picks() {
        let entries = vec![entry("game.nes", None, None)];
        let result = CliApp::group_disc_entries(&entries);
        assert!(result.disc_groups.is_empty());
        assert_eq!(result.standalone_entries, vec!["game.nes".to_string()]);
        assert_eq!(result.auto_pick.entry_name.as_deref(), Some("game.nes"));
        assert!(!result.auto_pick.ambiguous);
    }

    #[test]
    fn multiple_standalones_are_ambiguous() {
        let entries = vec![entry("a.nes", None, None), entry("b.nes", None, None)];
        let result = CliApp::group_disc_entries(&entries);
        assert!(result.auto_pick.entry_name.is_none());
        assert!(result.auto_pick.ambiguous);
    }

    #[test]
    fn complete_disc_plus_standalone_is_ambiguous() {
        let entries = vec![
            entry("Game.cue", None, Some(TWO_TRACK_CUE)),
            entry("Game (Track 1).bin", None, None),
            entry("Game (Track 2).bin", None, None),
            entry("extra.nes", None, None),
        ];
        let result = CliApp::group_disc_entries(&entries);
        assert_eq!(result.standalone_entries, vec!["extra.nes".to_string()]);
        assert!(result.auto_pick.ambiguous);
        assert!(result.auto_pick.entry_name.is_none());
    }

    #[test]
    fn empty_entry_list_picks_nothing() {
        let result = CliApp::group_disc_entries(&[]);
        assert!(result.auto_pick.entry_name.is_none());
        assert!(!result.auto_pick.ambiguous);
    }
}
