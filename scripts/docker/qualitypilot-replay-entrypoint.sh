#!/bin/bash
# Legacy alias wrapper — delegates cleanly to testigator-replay-entrypoint.sh.
exec "$(dirname "$0")/testigator-replay-entrypoint.sh" "$@"
