#!/bin/bash
# Testigator GitHub Action entrypoint — maps action inputs to `testigator replay`.
# GitHub docker actions run this with cwd=/github/workspace (the repo checkout),
# so a relative INPUT_PLAN resolves against the caller's repository.
set -uo pipefail

if [ -z "${INPUT_PLAN:-}" ]; then
  echo "::error::plan input is required (path to an exported testigator/plan or qualitypilot/plan JSON)"
  exit 64
fi
if [ -z "${INPUT_URL:-}" ]; then
  echo "::error::url input is required (the preview deployment to test)"
  exit 64
fi

ARGS=(replay "$INPUT_PLAN" --url "$INPUT_URL" --timeout "${INPUT_TIMEOUT:-600000}")
[ -n "${INPUT_FAIL_ON:-}" ] && ARGS+=(--fail-on "$INPUT_FAIL_ON")
[ -n "${INPUT_MIN_SCORE:-}" ] && ARGS+=(--min-score "$INPUT_MIN_SCORE")
[ -n "${INPUT_MAX_PAGES:-}" ] && ARGS+=(--max-pages "$INPUT_MAX_PAGES")
[ -n "${INPUT_IGNORE_FILE:-}" ] && ARGS+=(--ignore-file "$INPUT_IGNORE_FILE")
# Audit H-2: without this the replay never authorizes injection probing on a
# non-loopback preview target, so the documented staging probes silently skip.
if [ "${INPUT_AUTHORIZED_TARGET:-false}" = "true" ]; then
  ARGS+=(--authorized-target)
fi

# GITHUB_STEP_SUMMARY is honored inside the replay CLI (markdown job summary).
node src/cli/testigator.js "${ARGS[@]}"
exit $?
