# Packaging voltras-mcp as a channel plugin

The goal: run the push-event channel **without**
`--dangerously-load-development-channels`, which pops a full-screen warning dialog every
launch.

## Why the dev flag was the only option

Claude Code gates channel registration on the entry named in `--channels`. Reading the
gate in v2.1.220:

- A `server:<name>` entry (a plain `.mcp.json` server) can **never** be allowlisted. Its
  only path to registration is the development flag. This is why
  `--channels server:voltras` does not work and never will.
- A `plugin:<name>@<marketplace>` entry can be allowlisted, via
  `policySettings.allowedChannelPlugins` in machine-wide managed settings, which
  **replaces** Anthropic's built-in allowlist when present.
- The marketplace name in the `--channels` argument must match the marketplace the plugin
  was actually installed from, exactly, or the entry is skipped.

So the server has to become a plugin. Every skip is silent: no error, no log line, the
rest of the MCP keeps working over polling. Budget for that when debugging.

## What was added

| Path                                                 | Role                                         |
| ---------------------------------------------------- | -------------------------------------------- |
| `.claude-plugin/marketplace.json`                    | Marketplace `voltras-local`, repo root       |
| `plugins/voltras-channel/.claude-plugin/plugin.json` | Plugin `voltras-channel`                     |
| `plugins/voltras-channel/bin/voltras-mcp-launch.sh`  | Shim that locates and execs the built server |

Names, which have to agree in three places:

- marketplace: **`voltras-local`**
- plugin: **`voltras-channel`**
- MCP server key inside the plugin: **`voltras`**

giving the launch argument `--channels plugin:voltras-channel@voltras-local`.

The plugin declares the channel by binding it to that server key:

```json
"channels": [{ "server": "voltras" }]
```

The `server` value must match a key in the plugin's `mcpServers`. No extra capability
declaration is needed on the plugin side — `src/server.ts` already advertises
`experimental: { 'claude/channel': {} }`, which is what actually makes it a channel.

## Why the server is not bundled into the plugin

Installing a plugin copies its directory into `~/.claude/plugins/cache`, and an installed
plugin cannot reference anything outside that copy. Bundling would mean copying `dist/`
(gitignored) plus ~1000 `node_modules` packages on every version bump.

Instead `plugin.json` points at a shim:

```json
"mcpServers": { "voltras": { "command": "${CLAUDE_PLUGIN_ROOT}/bin/voltras-mcp-launch.sh" } }
```

`${CLAUDE_PLUGIN_ROOT}` is one of only three variables that substitute into MCP `command`
/ `args` / `env`; arbitrary `${MY_VAR}` does **not** expand there, which is why the
lookup lives in the shim rather than the manifest. The shim resolves the checkout in
order:

1. `$VOLTRAS_MCP_ENTRY` — absolute path to `dist/bin.js`
2. `$VOLTRAS_MCP_HOME` — repo root
3. `~/.voltras/mcp-home` — a file whose first line is the repo root
4. `voltras-mcp` on `PATH` (an `npm link`ed global bin)

`scripts/voltra-pt` exports `VOLTRAS_MCP_HOME` from its own location, so the launcher
needs no setup. For plain `claude`, write the pointer file once:

```bash
echo "$PWD" > ~/.voltras/mcp-home
```

Without one of these the server exits immediately and `/mcp` reports "Connection closed".

## Install

```bash
claude plugin marketplace add /absolute/path/to/voltras-mcp   # relative "." is rejected
claude plugin install voltras-channel@voltras-local
```

Then the managed-settings file below, then `scripts/voltra-pt`.

## The managed-settings file

macOS path: `/Library/Application Support/ClaudeCode/managed-settings.json`. It did not
exist on this machine, so the file below is a fresh one, not a merge. **Re-check before
installing** — if it exists by then, merge rather than overwrite; it is machine-wide
policy.

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [{ "marketplace": "voltras-local", "plugin": "voltras-channel" }]
}
```

Two caveats:

- `allowedChannelPlugins` **replaces** Anthropic's default allowlist rather than extending
  it. Once this file is in place, the official channel plugins (Telegram, Discord,
  iMessage, fakechat) stop being allowlisted. Add entries for them if you use them.
- The docs describe `allowedChannelPlugins` as a Team/Enterprise admin control. The gate
  itself does not block personal accounts, so it should apply here, but this is
  undocumented behavior of a research-preview feature and could change in any release.
  `VOLTRA_PT_DEV=1` exists for when it does.

## Launch modes

`scripts/voltra-pt` defaults to plugin mode and keeps the dev flag behind `VOLTRA_PT_DEV=1`:

```bash
lift                    # --channels plugin:voltras-channel@voltras-local
VOLTRA_PT_DEV=1 lift    # --dangerously-load-development-channels server:voltras
```

Plugin mode refuses to launch if a standalone `voltras` server is **also** registered with
`claude mcp`: the plugin ships the server too, so both would run, and two processes
collide on `~/.voltras/vmcp.sqlite` and port 7723. Under plugin mode, run
`claude mcp remove voltras`.

## Verification status

Confirmed working:

- `claude plugin validate` passes on both manifests
- marketplace adds, plugin installs and reports enabled at user scope
- the shim runs from the cache copy (exec bit survives the copy) and the real server
  speaks MCP on stdout
- `claude mcp list` reports `plugin:voltras-channel:voltras` — Connected
- `--channels plugin:voltras-channel@voltras-local` is accepted by the CLI
- `scripts/voltra-pt` preflight passes and launches in plugin mode

Not confirmed:

- **Channel events actually arriving.** That needs the managed-settings file (root-owned)
  and the gate is silent either way.
- **Tool exposure in a session.** In `--print` sessions the plugin's MCP tools do not
  appear in the tool list even though `claude mcp list` says Connected. This is probably
  the documented `/reload-plugins` step, which is interactive-only. Verify in a real
  interactive session.

To verify end to end once the settings file is installed, use the repo's own probe: call
`debug.push_test_channel`, read the `nonce` off the `<channel>` tag that arrives, echo it
back with `debug.confirm_channel`, then check `server.health` for `matchedProbe: true`.
That is the only positive proof the gate let the channel through.
