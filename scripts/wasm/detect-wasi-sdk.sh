#!/usr/bin/env bash
# Print the WASI SDK root, or nothing if none is found.
#
# Resolution order (first hit wins):
#   1. $WASI_SDK_PATH, if it already points at a real directory (CI sets this).
#   2. /opt/wasi-sdk
#   3. /opt/homebrew/opt/wasi-sdk
#   4. newest ~/.local/toolchains/wasi-sdk-*
#
# Kept outside mise tools so its clang does not shadow the host clang and break
# libarchive-sys bindgen on macOS. Mise consumes the printed root; absence still
# exits successfully so only WASM build tasks fail on a missing SDK.
set -uo pipefail

if [[ -n "${WASI_SDK_PATH:-}" && -d "${WASI_SDK_PATH}" ]]; then
  printf '%s' "$WASI_SDK_PATH"
  exit 0
fi

for candidate in /opt/wasi-sdk /opt/homebrew/opt/wasi-sdk; do
  if [[ -d "$candidate" ]]; then
    printf '%s' "$candidate"
    exit 0
  fi
done

newest_local="$(
  find "$HOME/.local/toolchains" -maxdepth 1 -type d -name 'wasi-sdk-*' 2>/dev/null \
    | sort -V \
    | tail -n 1
)"
if [[ -n "$newest_local" ]]; then
  printf '%s' "$newest_local"
fi

exit 0
