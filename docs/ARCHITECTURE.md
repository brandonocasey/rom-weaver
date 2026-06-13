# Architecture

How rom-weaver is put together: one Rust command core shipped two ways (native
CLI and a WASM build that runs in browser workers), with a React webapp driving
the WASM build over a JSON event protocol.

```
                 ┌────────────────────────────┐
                 │       rom-weaver-app       │  command orchestration
                 │  (shared command surface)  │  (probe/extract/checksum/
                 └─────────┬──────────┬───────┘   compress/trim/patch)
                           │          │
              native build │          │ wasm32-wasip1-threads build
                           ▼          ▼
                ┌───────────────┐  ┌──────────────────────┐
                │ rom-weaver-cli│  │ rom-weaver-cli (wasm) │ argv/reporter shim
                └───────────────┘  └──────────┬───────────┘
                                              │ JSON events over stdio
                                   ┌──────────▼───────────┐
                                   │ react src/wasm layer │ OPFS WASI runner,
                                   │    (browser-only)    │ thread pool, worker client
                                   └──────────┬───────────┘
                                   ┌──────────▼───────────┐
                                   │  rom-weaver-react    │ workflows, forms, PWA
                                   └──────────────────────┘
```

## Workspace layout

| Path | Role |
| --- | --- |
| `crates/rom-weaver-core` | Foundation: registry traits, `RomWeaverError`, I/O helpers, thread planning (`ThreadCapability`/`ThreadExecution` in `src/threads.rs`). Depends on nothing else in the workspace. |
| `crates/rom-weaver-checksum` | Checksum engines (crc32/md5/sha*/blake3/crc32c/crc16/adler32) plus the streaming variant engine shared by `checksum` and extract flows. |
| `crates/rom-weaver-codecs` | Standalone codec backends (zstd, deflate, lzma, …) behind `CodecBackend`. |
| `crates/rom-weaver-containers` | Container registry + per-format handlers (`src/handlers/*.rs`: zip, 7z, tar*, chd glue, rvz, z3ds, pbp, cso, …). |
| `crates/rom-weaver-chd` | Native CHD implementation (read sessions, create pipeline, codecs, disc inference). Exposed as a `ContainerHandler` + `ChdCodec`. |
| `crates/rom-weaver-patches` | Patch format handlers (`src/{ips,bps,ups,ppf,rup,…}.rs`), one file per format. |
| `crates/rom-weaver-xdelta` | VCDIFF/xdelta encode+decode, separate from `rom-weaver-patches` (parallel window encoding). Also exposes `apply_patch_bytes` for in-memory VCDIFF apply (used by `.dcp`). |
| `crates/rom-weaver-gdrom` | Dreamcast GD-ROM / CD data-track filesystem: read (`sector` cooking of `MODE1/2352`, `iso9660` parse, `GdRomFs` tree view with the +45000 LBA bias) and write (`iso_writer` authors a cooked ISO9660 image, `mode1` re-encodes EDC/ECC into raw `MODE1/2352`). Pure Rust, wasm-safe. |
| `crates/rom-weaver-dcp` | Universal Dreamcast Patcher (`.dcp`) format: ZIP central-directory reader + entry inflate (`zip`), entry classification (`manifest`), per-file apply (`apply`), and full data-track rebuild (`rebuild`). Builds on `rom-weaver-gdrom` + `rom-weaver-xdelta`. |
| `crates/rom-weaver-libarchive(-sys)` | libarchive FFI bindings (vendored under `vendor/libarchive`) used for zip/7z/tar/rar reads. |
| `crates/rom-weaver-app` | Command orchestration shared by every frontend: argument structs, selection/auto-extract resolution, trim/header-fix pipelines, patch command flows. |
| `crates/rom-weaver-cli` | Thin binary: clap parsing, progress/JSON reporters, native `main` and wasm `_start` entry. |
| `tools/rom-weaver-typegen` | ts-rs codegen from Rust types to `packages/rom-weaver-react/src/wasm/generated/`. |
| `packages/rom-weaver-react/src/wasm` | Browser wasm layer (same npm package): OPFS WASI runner (`run`/`runJson`), mounts, thread pool, worker client, generated types. |
| `packages/rom-weaver-react` | Webapp: workflow controllers, runtime adapters, React forms, workers, PWA shell. |
| `vendor/` | Vendored/forked deps (`nod` for RVZ, `libarchive`, `chd`, `qbsdiff`, `akv`). `nod` is a git submodule pointing at a fork — push changes to the fork remote, not upstream. |
| `scripts/` | WASM build orchestration (`build-wasm-cli.sh`, `wasm/with-wasi-env.sh`), benches, worktree setup. |

Crate dependency flow is one-directional: `core` ← format crates
(`checksum`/`codecs`/`containers`/`chd`/`patches`/`xdelta`/`gdrom`/`dcp`) ←
`app` ← `cli`. Format crates mostly do not depend on each other, with two
exceptions: `containers` consumes `chd`, `codecs`, and `libarchive` to assemble
its registry; and `dcp` consumes `gdrom` (data-track filesystem) and `xdelta`
(per-file VCDIFF apply).

## Core abstractions (`rom-weaver-core/src/registry.rs`)

Everything pluggable implements one of four traits, registered into a registry
keyed by `FormatDescriptor` (name + aliases + extensions, used for both CLI
`--format` matching and path-based probing):

- `ContainerHandler` (+ `ContainerHandlerOperations`): `probe`, `probe_details`,
  `list_entries`, `extract`, `create`, plus `capabilities()` describing what the
  format supports (create, dry-run sizing, …).
- `PatchHandler`: `probe`, `parse`, `apply`, `create`, with a default
  `validate` that dry-run applies to a temp path.
- `ChecksumEngine`: whole-file and range checksums.
- `CodecBackend`: standalone encode/decode.

Handlers return `OperationReport` (family, format, stage, label, JSON details,
percent, thread execution, status) — the single progress/result currency that
flows from format code through `rom-weaver-app` to the CLI reporters and, in
JSON mode, to the browser. `OperationContext` carries cancellation, temp-path
allocation, progress sinks, and thread budgets downward.

Registry entries are wrapped in tracing decorators
(`traced_container_handler`/`traced_patch_handler`/`traced_codec_backend`) so
every probe/extract/apply gets start/complete `trace!` spans for free.

Errors are one `thiserror` enum, `RomWeaverError`
(`rom-weaver-core/src/error.rs`), with `pub type Result<T>` alias. Validation
failures that need machine-readable codes use the structured
`ValidationCodeError` variant; do not add per-crate error types.

## Threading model

`ThreadCapability` (what a format *can* parallelize) and `ThreadExecution`
(what a run *actually* used) live in `rom-weaver-core/src/threads.rs`. Formats
plan a parallelism level from input size and the requested budget, build a
scoped pool, and report the outcome in `OperationReport.thread_execution`.

Patterns that matter when touching this code:

- **Producer/consumer pipelines.** CHD decode/create and RVZ create stream
  compressed data through bounded channels: a reader stage feeds worker
  decoders/encoders, and an ordered writer reassembles output. Memory is
  bounded (~1 GiB cap on CHD decode batches).
- **Read-on-main under WASM.** Spawned reader threads cannot open OPFS-backed
  files in the browser (WASI `os error 44`, worst on Safari). Container and
  patch pipelines therefore read source bytes on the main wasm thread and keep
  only compute on workers. Gated by `ROM_WEAVER_CONTAINER_MAIN_THREAD_READER`
  (see `rom-weaver-containers/src/constants.rs`).
- **Browser thread budgets.** "auto" is resolved on the JS side
  (`packages/rom-weaver-react/src/wasm/workers/browser-thread-budget.ts` and the
  React `toThreadBudget` path) before it reaches wasm — the wasm fallback is a
  fixed 4 threads, so passing "auto" through literally caps throughput.
- **Byte-identical parity.** Compression outputs are validated against
  reference tools (chdman, dolphin-tool). Performance changes to encode paths
  must keep outputs byte-identical; tests assert this.

`docs/browser-concurrency.md` covers the browser-side concurrency rules in
more depth.

## Dreamcast `.dcp` patches (the filesystem-level apply path)

Most patch formats are byte-stream transforms and fit `PatchHandler`. Universal
Dreamcast Patcher (`.dcp`) is different: it is a ZIP of per-file xdelta/VCDIFF
deltas (plus verbatim new files and an optional replacement `IP.BIN`) applied
*inside* a GD-ROM data track's ISO9660 filesystem, after which the filesystem is
rebuilt. It therefore does **not** register as a `PatchHandler`; it has a
dedicated path that rebuilds a whole disc track.

- **`rom-weaver-gdrom`** is the filesystem layer. A Dreamcast high-density data
  track is `MODE1/2352` raw sectors whose ISO9660 records use *absolute* LBAs
  biased by the track start (45000). `sector` cooks 2352→2048; `GdRomFs::open(reader, start_lba)`
  parses the PVD/directory tree resolving extents at `lba − start_lba`;
  `iso_writer::build_iso` authors a cooked image back (deterministic, pinnable
  timestamp, +start_lba bias); `mode1::encode_mode1_sector` re-adds sync/header/
  EDC (poly `0x8001801B`) /ECC (GF(2⁸), poly `0x11D`) — validated byte-for-byte
  against real disc sectors. The first 16 sectors are the IP.BIN boot area and
  are carried through (or replaced) on rebuild.
- **`rom-weaver-dcp`** owns the format: `zip` reads the central directory and
  inflates entries (miniz_oxide, no C deps → wasm-safe); `manifest` classifies
  each entry as `Delta`/`Verbatim`/`BootSector`; `apply::apply_dcp` produces each
  patched file via an I/O-free emit closure (so native and browser share it);
  `rebuild::rebuild_track_to_writer` plans the rebuilt layout from file *sizes*
  (a patched file's size is read from its VCDIFF header without decoding) and
  then **streams** the raw `MODE1/2352` track to a writer, producing each file's
  bytes on demand (delta applied against its freshly-read source, verbatim
  inflated, or untouched file read through) and dropping them immediately. The
  cooked image and raw track are never materialized, so peak memory scales with
  the largest single file's apply working set — not the disc or the patch.
- **CLI wiring.** `patch apply` detects a `.dcp` patch and routes to
  `rom-weaver-app/src/patch_apply_dcp.rs`, which requires a disc-sheet
  (`.cue`/`.gdi`) input, auto-selects the data track (largest track that opens
  as a `GdRomFs`), rebuilds it, then reuses the shared disc staging
  (`patch_apply_disc.rs`) to reassemble the full disc and compress to CHD by
  default (or write the disc beside the output sheet with `--no-compress`).

Parity note: output is currently *file-level* parity (every rebuilt file is
byte-correct, validated against the file-based xdelta handler), not necessarily
byte-identical to UDP's own disc image. Matching UDP's image byte-for-byte would
require reproducing DiscUtils' exact ISO9660 layout and is deferred.

## Rust ⇄ TypeScript boundary

- **Type generation.** `cargo run -p rom-weaver-typegen -- --write` (or
  `npm run typegen`) emits `rom-weaver-rust-types.d.ts`,
  `rom-weaver-format-metadata.ts`, and `rom-weaver-command-types.ts` into
  `packages/rom-weaver-react/src/wasm/generated/`. CI runs `--check`; any change to
  a `#[derive(TS)]` type or format registry metadata requires regenerating and
  committing. The generated format metadata is the single source for codec
  pickers and format tables in the webapp — do not hand-maintain duplicates.
- **Event protocol.** The wasm CLI is invoked with argv and `--json`; progress
  and results stream back as JSON lines (`RomWeaverRunJsonEvent`). The browser
  side never calls Rust functions directly — everything goes through the
  runner's argv/stdio surface, which is what keeps the native and browser CLIs
  behaviorally identical.
- **Workers only.** The OPFS runtime requires a Dedicated Worker (sync OPFS
  access handles and SharedArrayBuffer are unavailable on the main thread).
  `rom-weaver-react/src/workers/` hosts the worker entrypoints; the protocol
  types live in `src/workers/protocol/`.

## Build graph

```
cargo build (workspace)                     # native CLI
cargo run -p rom-weaver-typegen -- --write  # regen TS types when Rust types change
scripts/build-wasm-cli.sh                   # WASI SDK build → wasm-opt → brotli
                                            #   → sync into packages/rom-weaver-react/src/wasm
npm --prefix packages/rom-weaver-react run dev|build
```

The WASM build needs a WASI SDK (v33+, auto-detected; see
`scripts/wasm/with-wasi-env.sh`). Generated wasm artifacts in
`packages/rom-weaver-react/src/wasm` are gitignored; the generated *TypeScript*
files are
committed and drift-checked.

## Testing

| Layer | Where | What |
| --- | --- | --- |
| Rust unit | `crates/*/tests/unit/`, inline `#[test]` | Per-format parsers, registry, I/O, threads (~800 tests). |
| CLI smoke | `crates/rom-weaver-cli/tests/cli_smoke/` | End-to-end CLI runs against synthesized fixtures, per command family. Shared helpers in `shared.rs`. |
| WASM node | `packages/rom-weaver-react/tests/wasm/` | Worker client, OPFS protocols, format metadata (vitest, node). |
| Browser | `packages/rom-weaver-react/tests/browser/` | Playwright + vitest integration tests of the real worker/OPFS/wasm stack, including mobile-Safari-specific cases. |

CI (`.github/workflows/chd-rust-backend.yml`) runs fmt, clippy `-D warnings`,
typegen drift check, wasm-target checks, the full Rust test suite, the wasm
build, and both packages' lint/type/test/build. `lefthook.yml` mirrors the same
checks pre-commit, scoped by changed paths.

## Other docs

- `docs/browser-concurrency.md` — browser thread/worker rules
- `docs/mobile-safari-verification.md` — iOS Safari/WebKit verification steps
- `docs/chd-native-rust-migration.md` — history of the native CHD backend
- `docs/trim-revert-footer.md` — trim revert footer format
- `TODO.md` — delivery board / known gaps
- `REFERENCES.md` — format specs and reference implementations
