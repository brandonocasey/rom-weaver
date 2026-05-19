use std::fs;

use assert_cmd::Command;
use assert_fs::{TempDir, fixture::PathChild};
use serde_json::Value;

fn parse_json_lines(output: &[u8]) -> Vec<Value> {
    let text = String::from_utf8(output.to_vec()).expect("utf8 output");
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(serde_json::from_str(trimmed).expect("valid json line"))
            }
        })
        .collect()
}

fn write_fixture_file(temp: &TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let file = temp.child(name);
    fs::write(file.path(), bytes).expect("fixture");
    file.path().to_path_buf()
}

#[test]
fn json_trace_flag_emits_trace_json_to_stderr() {
    let temp = TempDir::new().expect("temp dir");
    let source = write_fixture_file(&temp, "input.bin", b"rom-weaver-trace-fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .env_remove("ROM_WEAVER_LOG")
        .env_remove("RUST_LOG")
        .args([
            "--json",
            "--trace",
            "checksum",
            source.to_str().expect("path"),
            "--algo",
            "crc32",
            "--no-extract",
        ])
        .assert()
        .code(0)
        .get_output()
        .clone();

    let stdout_events = parse_json_lines(&output.stdout);
    assert!(
        !stdout_events.is_empty(),
        "expected stdout json progress events"
    );
    assert!(
        stdout_events
            .iter()
            .any(|event| event["status"].as_str() == Some("succeeded")),
        "expected a succeeded terminal progress event"
    );

    let trace_events = parse_json_lines(&output.stderr);
    assert!(
        !trace_events.is_empty(),
        "expected stderr json trace events"
    );
    assert!(
        trace_events.iter().any(|event| event["target"]
            .as_str()
            .is_some_and(|target| target.starts_with("rom_weaver"))),
        "expected trace event target to include rom_weaver crate paths"
    );
}

#[test]
fn rom_weaver_log_env_enables_trace_without_trace_flag() {
    let temp = TempDir::new().expect("temp dir");
    let source = write_fixture_file(&temp, "input.bin", b"rom-weaver-trace-env");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .env("ROM_WEAVER_LOG", "rom_weaver_cli=trace")
        .env_remove("RUST_LOG")
        .args([
            "--json",
            "checksum",
            source.to_str().expect("path"),
            "--algo",
            "crc32",
            "--no-extract",
        ])
        .assert()
        .code(0)
        .get_output()
        .clone();

    let trace_events = parse_json_lines(&output.stderr);
    assert!(
        !trace_events.is_empty(),
        "expected stderr trace output when ROM_WEAVER_LOG is set"
    );
}

#[test]
fn json_mode_without_trace_keeps_stderr_clean() {
    let temp = TempDir::new().expect("temp dir");
    let source = write_fixture_file(&temp, "input.bin", b"rom-weaver-no-trace");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .env_remove("ROM_WEAVER_LOG")
        .env_remove("RUST_LOG")
        .args([
            "--json",
            "checksum",
            source.to_str().expect("path"),
            "--algo",
            "crc32",
            "--no-extract",
        ])
        .assert()
        .code(0)
        .get_output()
        .clone();

    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(stderr.trim().is_empty(), "expected stderr to remain empty");
}
