use std::{io, path::PathBuf};

use super::{RomWeaverError, RomWeaverErrorKind, UnsupportedOp, ValidationCodeError};

/// Canonical `Display` prefix the JS worker-error classifier
/// (`inferCoreWorkerErrorKind`) keys on for each [`RomWeaverErrorKind`]. Both
/// sides MUST agree on these strings; the JS contract test in
/// `packages/rom-weaver-react/tests/unit/worker-error-kind-contract.test.ts`
/// locks the same prefixes from the other direction.
fn canonical_prefix(kind: RomWeaverErrorKind) -> &'static str {
    match kind {
        RomWeaverErrorKind::Validation => "validation failed:",
        RomWeaverErrorKind::UnknownFormat => "unknown format for path",
        RomWeaverErrorKind::Unsupported => "unsupported operation:",
        // Cancelled renders an exact, argument-free message.
        RomWeaverErrorKind::Cancelled => "operation cancelled",
        RomWeaverErrorKind::Io => "i/o error:",
        RomWeaverErrorKind::ThreadPoolBuild => "thread pool build failed:",
    }
}

fn assert_error_contract(error: RomWeaverError, expected: RomWeaverErrorKind) {
    assert_eq!(
        error.kind(),
        expected,
        "kind() mismatch for `{error}`: expected {expected:?}, got {:?}",
        error.kind()
    );
    let rendered = error.to_string();
    let prefix = canonical_prefix(expected);
    assert!(
        rendered.starts_with(prefix),
        "Display for {expected:?} must start with the canonical JS prefix `{prefix}`; got `{rendered}`"
    );
}

#[test]
fn validation_variants_map_to_validation_kind_and_prefix() {
    assert_error_contract(
        RomWeaverError::Validation("boom".to_string()),
        RomWeaverErrorKind::Validation,
    );
    assert_error_contract(
        RomWeaverError::ValidationCode(ValidationCodeError::new("E_BAD")),
        RomWeaverErrorKind::Validation,
    );
}

#[test]
fn unknown_format_maps_to_unknown_format_kind_and_prefix() {
    assert_error_contract(
        RomWeaverError::UnknownFormat {
            path: PathBuf::from("/tmp/mystery.bin"),
        },
        RomWeaverErrorKind::UnknownFormat,
    );
}

#[test]
fn unsupported_maps_to_unsupported_kind_and_prefix() {
    assert_error_contract(
        RomWeaverError::Unsupported(UnsupportedOp::ChdStoreModeOnly),
        RomWeaverErrorKind::Unsupported,
    );
}

#[test]
fn cancelled_maps_to_cancelled_kind_and_exact_message() {
    let error = RomWeaverError::Cancelled;
    assert_eq!(error.kind(), RomWeaverErrorKind::Cancelled);
    // Cancelled has no arguments; lock the whole message, not just the prefix.
    assert_eq!(error.to_string(), "operation cancelled");
}

#[test]
fn io_maps_to_io_kind_and_prefix() {
    assert_error_contract(
        RomWeaverError::Io(io::Error::other("disk gone")),
        RomWeaverErrorKind::Io,
    );
}

#[test]
fn thread_pool_build_maps_to_thread_pool_build_kind_and_prefix() {
    assert_error_contract(
        RomWeaverError::ThreadPoolBuild("no threads".to_string()),
        RomWeaverErrorKind::ThreadPoolBuild,
    );
}

/// Exhaustiveness guard: the `match` forces every `RomWeaverError` variant to be
/// named here, so adding a new variant fails to compile until its expected kind
/// (and therefore its `Display`-prefix coverage above) is declared. This is the
/// loud signal that prevents a new error variant from slipping past the
/// message-prefix ⇄ kind contract.
#[test]
fn every_variant_is_covered_by_the_contract() {
    fn expected_kind(error: &RomWeaverError) -> RomWeaverErrorKind {
        match error {
            RomWeaverError::Validation(_) => RomWeaverErrorKind::Validation,
            RomWeaverError::ValidationCode(_) => RomWeaverErrorKind::Validation,
            RomWeaverError::UnknownFormat { .. } => RomWeaverErrorKind::UnknownFormat,
            RomWeaverError::Unsupported(_) => RomWeaverErrorKind::Unsupported,
            RomWeaverError::Cancelled => RomWeaverErrorKind::Cancelled,
            RomWeaverError::Io(_) => RomWeaverErrorKind::Io,
            RomWeaverError::ThreadPoolBuild(_) => RomWeaverErrorKind::ThreadPoolBuild,
        }
    }

    let samples = [
        RomWeaverError::Validation("x".to_string()),
        RomWeaverError::ValidationCode(ValidationCodeError::new("E")),
        RomWeaverError::UnknownFormat {
            path: PathBuf::from("/x"),
        },
        RomWeaverError::Unsupported(UnsupportedOp::ChdStoreModeOnly),
        RomWeaverError::Cancelled,
        RomWeaverError::Io(io::Error::other("x")),
        RomWeaverError::ThreadPoolBuild("x".to_string()),
    ];

    for error in samples {
        assert_eq!(error.kind(), expected_kind(&error));
    }
}
