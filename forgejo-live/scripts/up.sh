#!/bin/sh
# Starts Forgejo, the editor service and the proxy; prints the URL to open and the test accounts.
#   FORGEJO_LIVE_HOME=<data folder> FORGEJO_BIN=<forgejo binary> scripts/up.sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
service="$root/../yjs-bridge"
[ -d "$root/node_modules" ] || (cd "$root" && pnpm install --frozen-lockfile)
[ -d "$service/node_modules" ] || (cd "$service" && pnpm install --frozen-lockfile)
# the editor bundle is built on every start, so the page always matches the source
(cd "$service" && node web/build.js >/dev/null)
exec node "$here/up.mjs" "$@"
