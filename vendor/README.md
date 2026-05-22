# Vendored Dependencies

`rom-weaver` vendors a small set of dependencies for reproducibility and local patching.

## Current vendor contents

- `vendor/libarchive`:
  - Git submodule used by `crates/rom-weaver-libarchive-sys/build.rs`.
  - Initialize or refresh with:
    ```bash
    git submodule update --init --recursive vendor/libarchive
    ```

- `vendor/akv-0.1.0`:
  - Local patched copy of the `akv` crate.
  - Wired through root `Cargo.toml` `[patch.crates-io]`.

## Validate after vendor updates

```bash
cargo check -p rom-weaver-patches
cargo check -p rom-weaver-cli
```
