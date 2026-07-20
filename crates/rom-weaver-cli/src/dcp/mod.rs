//! Universal Dreamcast Patcher (`.dcp`) patch-format support.
//!
//! A `.dcp` is a ZIP of per-file VCDIFF deltas, verbatim additions, and an
//! optional replacement IP.BIN applied inside a Dreamcast ISO9660 filesystem.
//!
//! [`zip`] reads metadata and [`manifest`] classifies [`DcpOperation`]s; app-layer
//! orchestration reads source files, applies deltas, and rebuilds the disc.

pub mod apply;
pub mod manifest;
pub mod rebuild;
pub mod zip;

pub use apply::{DcpApplySummary, DcpOutput, apply_dcp};
pub use manifest::{DcpManifest, DcpOperation};
pub use rebuild::{RebuildSummary, rebuild_track_to_writer};
pub use zip::{ZipEntry, extract_entry, read_central_directory};

use std::io::{Read, Seek};

use rom_weaver_core::Result;

/// Read a `.dcp` archive's central directory and classify it into a
/// [`DcpManifest`].
pub fn read_manifest<R: Read + Seek>(reader: &mut R) -> Result<DcpManifest> {
    let entries = read_central_directory(reader)?;
    Ok(DcpManifest::from_entries(&entries))
}

#[cfg(test)]
#[path = "tests/dcp.rs"]
mod tests;
