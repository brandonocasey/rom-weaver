#!/usr/bin/env bash
# Run a check for its report rather than its exit status.
#
# Advisory scanners fail on dependencies we did not touch: a CVE is published
# against something transitive and every open pull request goes red at once,
# blocking unrelated work until someone lands an upgrade. This keeps the signal
# - a GitHub annotation plus the full output in the run summary - without the
# gate. Only wrap checks whose input is the outside world; anything we author
# should still fail loudly.
#
# Usage: scripts/warn-only.sh <label> <command> [args...]
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <label> <command> [args...]" >&2
  exit 2
fi

label="$1"
shift

output=$("$@" 2>&1)
status=$?
printf '%s\n' "$output"

if [ "$status" -eq 0 ]; then
  exit 0
fi

echo "::warning title=${label}::reported findings (exit ${status}) - see the job summary"
{
  echo "### ⚠️ ${label}"
  echo
  echo '```'
  printf '%s\n' "$output"
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
