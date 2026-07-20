//! GD-ROM / CD data-track filesystem support for rom-weaver.
//!
//! Reads and rebuilds Dreamcast GD-ROM/CD ISO9660 data tracks, including raw
//! `MODE1/2352` framing and absolute-LBA bias, for `.dcp` apply.
//!
//! [`sector`] reads logical sectors, [`iso9660`] parses them, [`GdRomFs`] exposes
//! files, [`iso_writer`] rebuilds the image, and [`mode1`] restores raw framing.

mod filesystem;
pub mod iso9660;
pub mod iso_writer;
pub mod mode1;
pub mod sector;

pub use filesystem::{BOOT_AREA_SIZE, FileEntry, GD_HIGH_DENSITY_START_LBA, GdRomFs};
pub use iso_writer::{
    IsoEntry, IsoFile, IsoPlan, IsoTimestamp, PlannedFile, build_iso, plan_iso, write_track,
};
pub use mode1::{RAW_SECTOR_SIZE, USER_DATA_SIZE, encode_mode1_sector};
pub use sector::{LOGICAL_SECTOR_SIZE, SectorFormat, TrackSectors};

#[cfg(test)]
#[path = "tests/gdrom.rs"]
mod tests;

#[cfg(test)]
#[path = "tests/mode1.rs"]
mod mode1_tests;

#[cfg(test)]
#[path = "tests/iso_writer.rs"]
mod iso_writer_tests;
