#!/usr/bin/env bash
set -euo pipefail

rust=false
wasm=false
webapp=false
security=false
full=false

if [[ "${1:-}" == "--all" ]]; then
  rust=true
  wasm=true
  webapp=true
  security=true
  full=true
else
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue

    case "$path" in
      .github/workflows/ci.yml | .github/workflows/coverage.yml | \
        .github/actions/setup-build-env/* | .github/actions/wasm-cache/* | \
        .cargo/* | .mise.toml | scripts/ci/classify-changes.sh | \
        scripts/ci/mise-disable-tools.sh | scripts/ci/resolve-wasm-run.sh)
        full=true
        ;;
    esac

    case "$path" in
      crates/* | Cargo.toml | Cargo.lock | deny.toml | \
        scripts/check-thread-guards.sh | scripts/gen-third-party-licenses.mjs | \
        scripts/vendored-pathspecs.sh | scripts/wasm/*)
        rust=true
        wasm=true
        webapp=true
        ;;
    esac

    case "$path" in
      packages/rom-weaver-webapp/* | package.json | package-lock.json | \
        scripts/*.mjs | scripts/wasm/* | Dockerfile | .dockerignore | \
        docker-compose.yml | .github/workflows/docker-publish.yml)
        webapp=true
        ;;
    esac

    case "$path" in
      Cargo.toml | Cargo.lock | crates/*/Cargo.toml | package.json | package-lock.json | \
        packages/rom-weaver-webapp/package.json | packages/rom-weaver-webapp/package-lock.json)
        security=true
        ;;
    esac
  done
fi

if [[ "$full" == true ]]; then
  rust=true
  wasm=true
  webapp=true
  security=true
fi

printf 'rust=%s\nwasm=%s\nwebapp=%s\nsecurity=%s\nfull=%s\n' \
  "$rust" "$wasm" "$webapp" "$security" "$full"
