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
