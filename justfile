# Convenience recipes for voltras-mcp. `just` is optional — every recipe is a
# one-line wrapper around a plain command; see README "Launching" for the
# equivalents if you don't have `just` installed.

# tsc -> dist/ (the server binary)
build:
    npm run build

# vite -> dist/spa (the web dashboard)
dashboard:
    npm run build:dashboard

# vitest run
test:
    npm test

# tsc --noEmit (server + dashboard SPA)
typecheck:
    npm run typecheck

# eslint src
lint:
    npm run lint

# Boot the real MCP server against the mock adapter with the dashboard on an
# OS-assigned port, isolated from any real session's SQLite file.
sim:
    VOLTRA_ADAPTER=mock VMCP_DB_PATH=$(mktemp -u /tmp/vmcp-sim-XXXX.sqlite) VMCP_DASHBOARD_PORT=0 \
        VOLTRAS_MCP_HOME="{{justfile_directory()}}" \
        "{{justfile_directory()}}/plugins/voltras-channel/bin/voltras-mcp-launch.sh"

# Bench pre-flight, then the plugin launcher against a real device.
bench:
    node "{{justfile_directory()}}/scripts/preflight.mjs"
    VOLTRAS_MCP_HOME="{{justfile_directory()}}" VOLTRA_PT=1 \
        "{{justfile_directory()}}/plugins/voltras-channel/bin/voltras-mcp-launch.sh"
