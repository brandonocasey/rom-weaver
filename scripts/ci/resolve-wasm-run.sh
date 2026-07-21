#!/usr/bin/env bash
# Find the CI run that built the `wasm-prod` artifact for a given commit.
#
# Coverage and the release packaging job both want the exact module CI tested
# rather than a fresh ~6.5 min build of their own. Both need the same three
# steps - prefer the run that triggered us, confirm it is actually for this
# commit, otherwise search by commit - and getting the middle one wrong means
# silently measuring or shipping a module built from different source.
#
# Writes `run_id=` and `available=` to $GITHUB_OUTPUT. Callers decide what an
# unavailable artifact means: coverage sets REQUIRE_ARTIFACT and fails, release
# leaves it unset and falls back to building from source.
#
# Env: GH_TOKEN, GITHUB_REPOSITORY, TARGET_SHA, PREFERRED_RUN_ID (optional),
#      REQUIRE_ARTIFACT (optional).
set -euo pipefail

: "${GITHUB_REPOSITORY:?}"
: "${TARGET_SHA:?}"
run_id="${PREFERRED_RUN_ID:-}"

# A workflow_run event can fire for a run of a different commit (a re-run, or a
# race with a newer push), so the hint is verified before it is trusted.
if [ -n "$run_id" ]; then
  run_sha=$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}" --jq .head_sha)
  if [ "$run_sha" != "$TARGET_SHA" ]; then
    echo "run ${run_id} is for ${run_sha}, not ${TARGET_SHA} - searching by commit"
    run_id=""
  fi
fi

if [ -z "$run_id" ]; then
  run_id=$(gh run list \
    --repo "$GITHUB_REPOSITORY" \
    --workflow ci.yml \
    --commit "$TARGET_SHA" \
    --status success \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId')
fi

# Artifacts expire, so a run existing is not the same as its artifact existing.
available=false
if [ -n "$run_id" ]; then
  count=$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/artifacts" \
    --jq '[.artifacts[] | select(.name == "wasm-prod" and .expired == false)] | length')
  if [ "$count" -gt 0 ]; then
    available=true
  fi
fi

echo "run_id=${run_id} available=${available} (sha ${TARGET_SHA})"
{
  echo "run_id=$run_id"
  echo "available=$available"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"

if [ "$available" != true ] && [ -n "${REQUIRE_ARTIFACT:-}" ]; then
  echo "::error::no unexpired wasm-prod artifact for ${TARGET_SHA}"
  exit 1
fi
