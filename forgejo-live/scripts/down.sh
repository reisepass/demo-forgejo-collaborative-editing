#!/bin/sh
# Stops the processes scripts/up.sh started (by recorded pid) and nothing else.
#   FORGEJO_LIVE_HOME=<data folder> scripts/down.sh
here=$(cd "$(dirname "$0")" && pwd)
exec node "$here/down.mjs" "$@"
