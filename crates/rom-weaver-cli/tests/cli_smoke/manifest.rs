use super::shared::*;

fn write_min_ips(temp: &TempDir, name: &str) -> PathBuf {
    let patch = temp.child(name);
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![0xAA],
            }],
            None,
        ),
    )
    .expect("ips fixture");
    patch.path().to_path_buf()
}

#[test]
fn manifest_parse_plain_json_resolves_refs_verbatim() {
    let temp = setup_temp_dir();
    let manifest = temp.child("rw.json");
    fs::write(
        manifest.path(),
        r#"{
            "version": 1,
            "name": "Example Pack",
            "rom": { "url": "https://example.test/roms/game.sfc" },
            "patches": [
                { "path": "main.ips", "status": "required", "label": "stable" },
                { "url": "patches/extra.bps", "status": "optional" }
            ],
            "output": { "name": "out.sfc", "compress": false }
        }"#,
    )
    .expect("manifest fixture");

    let events = run_json_events(
        &[
            "manifest",
            "parse",
            manifest.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["manifest"];
    assert_eq!(result["source_kind"], "json");
    assert_eq!(result["manifest"]["version"], 1);
    assert_eq!(result["manifest"]["name"], "Example Pack");
    assert_eq!(result["manifest"]["patches"][0]["status"], "required");
    assert_eq!(result["manifest"]["patches"][0]["label"], "stable");
    assert_eq!(result["manifest"]["output"]["compress"], false);
    assert_eq!(
        result["rom_source"]["url"], "https://example.test/roms/game.sfc",
        "url refs pass through verbatim"
    );
    assert_eq!(
        result["patch_sources"][0]["source"]["path"], "main.ips",
        "path refs stay manifest-relative for a plain manifest"
    );
    assert_eq!(
        result["patch_sources"][1]["source"]["url"], "patches/extra.bps",
        "relative urls pass through verbatim (the caller resolves them)"
    );
    assert!(
        result["patch_sources"][0]["descriptor"].is_null(),
        "unextracted entries carry no descriptor"
    );
    assert_eq!(result["warnings"].as_array().expect("warnings").len(), 0);
}

#[test]
fn manifest_parse_reads_gzipped_manifest() {
    let temp = setup_temp_dir();
    let manifest = temp.child("rw.json.gz");
    let json = r#"{ "version": 1, "patches": [ { "path": "main.ips" } ] }"#;
    let file = File::create(manifest.path()).expect("create rw.json.gz");
    let mut encoder = GzEncoder::new(file, DeflateCompression::default());
    encoder.write_all(json.as_bytes()).expect("gzip manifest");
    encoder.finish().expect("finish gzip manifest");

    let events = run_json_events(
        &[
            "manifest",
            "parse",
            manifest.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["manifest"];
    assert_eq!(result["source_kind"], "compressed-json");
    assert_eq!(result["manifest"]["patches"][0]["path"], "main.ips");
}

#[test]
fn manifest_parse_archive_extracts_referenced_members() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"0123456789abcdef").expect("rom fixture");
    let patch_path = write_min_ips(&temp, "main.ips");
    let manifest = temp.child("rw.json");
    fs::write(
        manifest.path(),
        r#"{
            "version": 1,
            "rom": { "path": "roms/game.bin" },
            "patches": [ { "path": "patches/main.ips", "description": "main hack" } ]
        }"#,
    )
    .expect("manifest fixture");
    let bundle = temp.child("bundle.tar.gz");
    write_tar_gz_fixture(
        &[
            (manifest.path(), "rw.json"),
            (rom.path(), "roms/game.bin"),
            (&patch_path, "patches/main.ips"),
        ],
        bundle.path(),
    );
    let extract_dir = temp.child("manifest-out");

    let events = run_json_events(
        &[
            "manifest",
            "parse",
            bundle.path().to_str().expect("path"),
            "--extract-dir",
            extract_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "succeeded");
    let result = &terminal["details"]["manifest"];
    assert_eq!(result["source_kind"], "archive");
    assert_eq!(result["archive_member"], "rw.json");

    let rom_path = result["rom_source"]["extracted_path"]
        .as_str()
        .expect("rom extracted path");
    assert!(
        rom_path.ends_with("roms/game.bin"),
        "unexpected rom path: {rom_path}"
    );
    assert_eq!(
        fs::read(rom_path).expect("extracted rom readable"),
        b"0123456789abcdef"
    );

    let patch_source = &result["patch_sources"][0];
    let extracted_patch = patch_source["source"]["extracted_path"]
        .as_str()
        .expect("patch extracted path");
    assert!(
        fs::metadata(extracted_patch)
            .expect("extracted patch")
            .is_file()
    );
    assert_eq!(patch_source["descriptor"]["format"], "IPS");
    assert_eq!(patch_source["descriptor"]["is_valid_patch"], true);
}

#[test]
fn manifest_parse_archive_without_manifest_fails() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"0123456789abcdef").expect("rom fixture");
    let bundle = temp.child("bundle.tar.gz");
    write_tar_gz_fixture(&[(rom.path(), "roms/game.bin")], bundle.path());

    let events = run_json_events(
        &[
            "manifest",
            "parse",
            bundle.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("failure label");
    assert!(
        label.contains("manifest.missing"),
        "expected manifest.missing code in label: {label}"
    );
}

const MANIFEST_ROM_BYTES: &[u8] = b"0123456789abcdef";

fn write_manifest_rom(temp: &TempDir, name: &str) -> PathBuf {
    let rom = temp.child(name);
    fs::write(rom.path(), MANIFEST_ROM_BYTES).expect("rom fixture");
    rom.path().to_path_buf()
}

fn write_offset_ips(temp: &TempDir, name: &str, offset: u32, value: u8) -> PathBuf {
    let patch = temp.child(name);
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset,
                data: vec![value],
            }],
            None,
        ),
    )
    .expect("ips fixture");
    patch.path().to_path_buf()
}

fn patched_rom_bytes(edits: &[(usize, u8)]) -> Vec<u8> {
    let mut bytes = MANIFEST_ROM_BYTES.to_vec();
    for (offset, value) in edits {
        bytes[*offset] = *value;
    }
    bytes
}

#[test]
fn manifest_apply_plain_manifest_input_uses_output_name() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips", "status": "required" } ],
            "output": { "name": "out.bin", "compress": false }
        }"#,
    )
    .expect("manifest fixture");

    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.current_dir(temp.path());
    command.args(["patch", "apply", "--input", "rw.json", "--json"]);
    let stdout = command.assert().code(0).get_output().stdout.clone();
    let terminal = parse_json_lines(&stdout).last().expect("terminal").clone();
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("out.bin").path()).expect("manifest-named output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

#[test]
fn manifest_apply_gzipped_manifest_with_cli_output() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    let manifest = temp.child("rw.json.gz");
    let json = r#"{ "version": 1,
                    "rom": { "path": "game.bin" },
                    "patches": [ { "path": "main.ips" } ],
                    "output": { "compress": false } }"#;
    let file = File::create(manifest.path()).expect("create rw.json.gz");
    let mut encoder = GzEncoder::new(file, DeflateCompression::default());
    encoder.write_all(json.as_bytes()).expect("gzip manifest");
    encoder.finish().expect("finish gzip manifest");
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            manifest.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

fn write_everything_archive(temp: &TempDir, manifest_json: &str) -> PathBuf {
    let rom = write_manifest_rom(temp, "game.bin");
    let main = write_offset_ips(temp, "main.ips", 0, 0xAA);
    let extra = write_offset_ips(temp, "extra.ips", 1, 0xBB);
    let manifest = temp.child("rw.json");
    fs::write(manifest.path(), manifest_json).expect("manifest fixture");
    let bundle = temp.child("bundle.tar.gz");
    write_tar_gz_fixture(
        &[
            (manifest.path(), "rw.json"),
            (&rom, "roms/game.bin"),
            (&main, "patches/main.ips"),
            (&extra, "patches/extra.ips"),
        ],
        bundle.path(),
    );
    bundle.path().to_path_buf()
}

const EVERYTHING_MANIFEST: &str = r#"{
    "version": 1,
    "rom": { "path": "roms/game.bin" },
    "patches": [
        { "path": "patches/main.ips",  "name": "Main hack", "status": "required" },
        { "path": "patches/extra.ips", "name": "Extra",     "status": "optional" }
    ],
    "output": { "compress": false }
}"#;

#[test]
fn manifest_apply_everything_archive_skips_optional() {
    let temp = setup_temp_dir();
    let bundle = write_everything_archive(&temp, EVERYTHING_MANIFEST);
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)]),
        "optional patch must not apply without --with"
    );
}

#[test]
fn manifest_apply_with_flag_includes_optional() {
    let temp = setup_temp_dir();
    let bundle = write_everything_archive(&temp, EVERYTHING_MANIFEST);
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.to_str().expect("path"),
            "--with",
            "Extra",
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA), (1, 0xBB)])
    );
}

#[test]
fn manifest_apply_without_required_errors() {
    let temp = setup_temp_dir();
    let bundle = write_everything_archive(&temp, EVERYTHING_MANIFEST);

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            bundle.to_str().expect("path"),
            "--without",
            "Main*",
            "--output",
            temp.child("patched.bin").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("manifest.status.required-excluded"),
        "unexpected label: {}",
        terminal["label"]
    );
}

#[test]
fn manifest_apply_rom_checks_mismatch_fails() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin", "checks": { "checksums": { "crc32": "00000000" } } },
            "patches": [ { "path": "main.ips" } ],
            "output": { "compress": false }
        }"#,
    )
    .expect("manifest fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rw.json").path().to_str().expect("path"),
            "--output",
            temp.child("patched.bin").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("label");
    assert!(
        label.contains("crc32") && label.contains("00000000"),
        "expected crc32 mismatch in label: {label}"
    );
}

#[test]
fn manifest_apply_integrity_mismatch_fails() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips", "integrity": { "crc32": "00000000" } } ],
            "output": { "compress": false }
        }"#,
    )
    .expect("manifest fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rw.json").path().to_str().expect("path"),
            "--output",
            temp.child("patched.bin").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("manifest.integrity.mismatch"),
        "unexpected label: {}",
        terminal["label"]
    );
}

#[test]
fn manifest_apply_explicit_manifest_flag_keeps_input_rom() {
    let temp = setup_temp_dir();
    let rom = write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    // The manifest's rom entry points at a nonexistent URL host on purpose:
    // with --manifest the positional input supplies the ROM, so the rom
    // source must be ignored (its checks are not — none set here).
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "url": "https://example.test/never-fetched.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "compress": false }
        }"#,
    )
    .expect("manifest fixture");
    let output = temp.child("patched.bin");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            rom.to_str().expect("path"),
            "--manifest",
            temp.child("rw.json").path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(events.last().expect("terminal")["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output exists"),
        patched_rom_bytes(&[(0, 0xAA)])
    );
}

#[test]
fn manifest_apply_cli_output_overrides_manifest_name() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "name": "manifest-named.bin", "compress": false }
        }"#,
    )
    .expect("manifest fixture");
    let output = temp.child("cli-named.bin");

    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.current_dir(temp.path());
    command.args([
        "patch",
        "apply",
        "--input",
        "rw.json",
        "--output",
        "cli-named.bin",
        "--json",
    ]);
    command.assert().code(0);
    assert!(output.path().is_file(), "explicit --output path must win");
    assert!(
        !temp.child("manifest-named.bin").path().exists(),
        "manifest output.name must not be written when --output is given"
    );
}

#[test]
fn manifest_apply_missing_output_fails_with_code() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "compress": false }
        }"#,
    )
    .expect("manifest fixture");

    let events = run_json_events(
        &[
            "patch-apply",
            "--input",
            temp.child("rw.json").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let terminal = events.last().expect("terminal");
    assert_eq!(terminal["status"], "failed");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("manifest.output.missing"),
        "unexpected label: {}",
        terminal["label"]
    );
}

#[test]
fn manifest_apply_manifest_compression_settings_apply() {
    let temp = setup_temp_dir();
    write_manifest_rom(&temp, "game.bin");
    write_offset_ips(&temp, "main.ips", 0, 0xAA);
    fs::write(
        temp.child("rw.json").path(),
        r#"{
            "version": 1,
            "rom": { "path": "game.bin" },
            "patches": [ { "path": "main.ips" } ],
            "output": { "name": "out.zip", "compress": { "format": "zip", "level": "min" } }
        }"#,
    )
    .expect("manifest fixture");

    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.current_dir(temp.path());
    command.args(["patch", "apply", "--input", "rw.json", "--json"]);
    command.assert().code(0);
    let zipped = fs::read(temp.child("out.zip").path()).expect("zip output exists");
    assert_eq!(
        &zipped[..2],
        b"PK",
        "manifest compression must produce a zip"
    );
}
