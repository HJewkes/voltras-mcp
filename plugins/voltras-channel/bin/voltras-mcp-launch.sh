#!/usr/bin/env bash
# Launch the voltras-mcp server for the voltras-channel plugin.
#
# The built server lives in the voltras-mcp repo (dist/ is gitignored, and the
# repo carries ~1000 node_modules packages), so it is deliberately NOT bundled
# into the plugin. Claude Code copies an installed plugin into
# ~/.claude/plugins/cache and refuses to resolve paths outside that copy, so
# this shim locates the real checkout at spawn time instead.
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
# stdout is the MCP stdio transport — every diagnostic here goes to stderr.

set -euo pipefail

fail() {
  echo "voltras-channel: $1" >&2
  exit 1
}

entry=""

if [ -n "${VOLTRAS_MCP_ENTRY:-}" ]; then
  entry="$VOLTRAS_MCP_ENTRY"
elif [ -n "${VOLTRAS_MCP_HOME:-}" ]; then
  entry="$VOLTRAS_MCP_HOME/dist/bin.js"
elif [ -r "$HOME/.voltras/mcp-home" ]; then
  read -r home <"$HOME/.voltras/mcp-home" || home=""
  [ -n "$home" ] || fail "~/.voltras/mcp-home is empty; write the repo root into it."
  entry="$home/dist/bin.js"
elif command -v voltras-mcp >/dev/null 2>&1; then
  exec voltras-mcp "$@"
else
  fail "cannot locate the voltras-mcp server.
Set VOLTRAS_MCP_HOME to the repo root, write it to ~/.voltras/mcp-home, or
\`npm link\` the repo so \`voltras-mcp\` is on PATH."
fi

[ -f "$entry" ] || fail "no server at $entry — run \`npm run build\` in the voltras-mcp repo."

exec node "$entry" "$@"
