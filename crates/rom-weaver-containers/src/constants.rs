pub(crate) const LIBARCHIVE_CREATE_IO_BUFFER_BYTES: usize = 128 * 1024;
pub(crate) const LIBARCHIVE_CREATE_ZSTD_IO_BUFFER_BYTES: usize = 1024 * 1024;
pub(crate) const LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const PARALLEL_COORDINATOR_STACK_SIZE_BYTES: usize = 8 * 1024 * 1024;

/// Native-only escape hatch (set to `"1"`) that forces container pipelines onto the
/// main-thread reader path so it can be exercised outside the browser/wasm runtime.
pub(crate) const MAIN_THREAD_READER_ENV: &str = "ROM_WEAVER_CONTAINER_MAIN_THREAD_READER";

const COPY_PROGRESS_DEFAULT_BUFFER_BYTES: usize = 64 * 1024;
const COPY_PROGRESS_MIN_BUFFER_BYTES: u64 = 16 * 1024;
const COPY_PROGRESS_MAX_BUFFER_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) const Z3DS_DEFAULT_FRAME_SIZE_BYTES: usize = 256 * 1024;
pub(crate) const Z3DS_DEFAULT_COMPRESSION_LEVEL: i32 = 3;
pub(crate) const Z3DS_MIN_COMPRESSION_LEVEL: i32 = 0;
pub(crate) const Z3DS_MAX_COMPRESSION_LEVEL: i32 = 22;
pub(crate) const Z3DS_EXTRACT_CHUNK_BYTES: usize = Z3DS_DEFAULT_FRAME_SIZE_BYTES;

pub(crate) fn copy_progress_buffer_size(total_bytes: u64) -> usize {
    if total_bytes == 0 {
        return COPY_PROGRESS_DEFAULT_BUFFER_BYTES;
    }
    (total_bytes / 100).clamp(
        COPY_PROGRESS_MIN_BUFFER_BYTES,
        COPY_PROGRESS_MAX_BUFFER_BYTES,
    ) as usize
}
