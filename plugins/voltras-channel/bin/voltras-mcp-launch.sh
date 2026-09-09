#!/usr/bin/env bash
# Launch the voltras-mcp server for the voltras-channel plugin.
#
# The built server lives in the voltras-mcp repo (dist/ is gitignored, and the
# repo carries ~1000 node_modules packages), so it is deliberately NOT bundled
# into the plugin. Claude Code copies an installed plugin into
# ~/.claude/plugins/cache and refuses to resolve paths outside that copy, so
# this shim locates the real checkout at spawn time instead.
#
# This is the ONE launcher: the justfile and scripts/voltra-pt both exec this
# same script rather than duplicating its resolution/build logic.
#
# Resolution order (first hit wins):
#   1. $VOLTRAS_MCP_ENTRY        — absolute path to dist/bin.js
#   2. $VOLTRAS_MCP_HOME         — repo root; uses $VOLTRAS_MCP_HOME/dist/bin.js
#   3. ~/.voltras/mcp-home       — file whose first line is the repo root
#   4. voltras-mcp on PATH       — an `npm link`ed global bin
#
# scripts/voltra-pt exports VOLTRAS_MCP_HOME from its own location, so the
# launcher path needs no setup. For launching plain `claude`, write the pointer
# file once:  echo "$PWD" > ~/.voltras/mcp-home
#
# When the repo root is known (cases 1-3), the launcher also:
#   - sources <repo root>/.launch.env if present (see .launch.env.example),
#     exporting every variable it sets into the server's environment
#   - runs `npm run build:dashboard` if dist/spa is missing or stale relative
#     to src/dashboard/spa, so a fresh checkout serves a working /app
#
# stdout is the MCP stdio transport — every diagnostic here goes to stderr.

set -euo pipefail

fail() {
  echo "voltras-channel: $1" >&2
  exit 1
}

# VW-183: a plugin-registered channel can auto-start this server for ANY
# Claude Code session that has voltras-channel installed, not just a PT
# session (scripts/voltra-pt). Default the dashboard sidecar off so those
# sessions don't bind a stray HTTP port; scripts/voltra-pt sets VOLTRA_PT=1
# to opt back into the default port. An explicit VMCP_DASHBOARD_PORT
# (from the caller's environment or .launch.env below) always wins. Runs
# before entry resolution so it also covers the PATH-installed fallback.
if [ -z "${VMCP_DASHBOARD_PORT:-}" ] && [ "${VOLTRA_PT:-0}" != "1" ]; then
  export VMCP_DASHBOARD_PORT=off
fi

repo_root=""
entry=""

if [ -n "${VOLTRAS_MCP_ENTRY:-}" ]; then
  entry="$VOLTRAS_MCP_ENTRY"
  repo_root="$(cd "$(dirname "$entry")/.." && pwd)"
elif [ -n "${VOLTRAS_MCP_HOME:-}" ]; then
  repo_root="$VOLTRAS_MCP_HOME"
  entry="$repo_root/dist/bin.js"
elif [ -r "$HOME/.voltras/mcp-home" ]; then
  read -r home <"$HOME/.voltras/mcp-home" || home=""
  [ -n "$home" ] || fail "~/.voltras/mcp-home is empty; write the repo root into it."
  repo_root="$home"
  entry="$repo_root/dist/bin.js"
elif command -v voltras-mcp >/dev/null 2>&1; then
  exec voltras-mcp "$@"
else
  fail "cannot locate the voltras-mcp server.
Set VOLTRAS_MCP_HOME to the repo root, write it to ~/.voltras/mcp-home, or
\`npm link\` the repo so \`voltras-mcp\` is on PATH."
fi

if [ -f "$repo_root/.launch.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$repo_root/.launch.env"
  set +a
fi

[ -f "$entry" ] || fail "no server at $entry — run \`npm run build\` in the voltras-mcp repo."

spa_src="$repo_root/src/dashboard/spa"
spa_marker="$repo_root/dist/spa/index.html"
if [ -d "$spa_src" ]; then
  if [ ! -f "$spa_marker" ] || [ -n "$(find "$spa_src" -newer "$spa_marker" -print -quit)" ]; then
    echo "voltras-channel: dashboard SPA missing or stale, running npm run build:dashboard" >&2
    (cd "$repo_root" && npm run build:dashboard) >&2
  fi
fi

exec node "$entry" "$@"
