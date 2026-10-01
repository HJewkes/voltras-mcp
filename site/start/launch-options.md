---
diataxis: how-to
audience: [lifter, developer]
status: available
sources:
  - README.md
  - scripts/voltra-pt
  - plugins/voltras-channel/bin/voltras-mcp-launch.sh
  - docs/channel-plugin-packaging.md
  - docs/bench-preflight.md
  - .launch.env.example
  - justfile
  - src/store/sqlite-store.ts
  - src/dashboard/server.ts
  - src/server.ts
  - scripts/preflight.mjs
  - scripts/lib/preflight-gates.mjs
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Launch options

[Install](/start/install) ends with plain registration: `claude mcp add` and a restart. That
gives Claude every tool, but the server cannot push rep and set events into the
conversation, so the model has to poll for them. The `voltra-pt` launcher adds push events.
Pick one of the two, not both.

| You want                                  | Use                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Tools only, no push events                | Plain registration from [Install](/start/install), or an entry in `~/.claude.json` |
| Push events and a personal-trainer prompt | The `voltra-pt` launcher with the `voltras-channel` plugin                         |

## The launcher script

The plugin route and the `just` recipes run one script,
`plugins/voltras-channel/bin/voltras-mcp-launch.sh`. `scripts/voltra-pt` reaches it through the
plugin. When the script can find the repo root, it sources `.launch.env` from there if that
file exists, builds the dashboard when `dist/spa` is missing or stale, then runs the built
server. When it falls back to an `npm link`ed `voltras-mcp` on your `PATH`, it runs that
directly and does neither. Plain registration from [Install](/start/install) does not use
the script. ([README.md § Launching](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#launching))

The launcher turns the dashboard off unless something asks for it. It sets
`VMCP_DASHBOARD_PORT=off` when that variable is unset and `VOLTRA_PT` is not `1`. The
reason: an installed plugin can start the server for any Claude Code session, and those
sessions should not hold a stray port. `scripts/voltra-pt` sets `VOLTRA_PT=1`, so a PT
session keeps the default port. An explicit `VMCP_DASHBOARD_PORT` always wins.
(`plugins/voltras-channel/bin/voltras-mcp-launch.sh`, `scripts/voltra-pt`)

## The voltra-pt launcher, for push events

`scripts/voltra-pt` starts Claude Code with the channel capability turned on and fills in a
personal-trainer prompt. ([README.md § Optional: the voltra-pt launcher](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#optional-the-voltra-pt-launcher))

::: warning Not run for this page
The plugin install and the managed-settings file were not run while writing this page,
because they change machine-wide Claude Code settings. The steps below restate the README.
[docs/channel-plugin-packaging.md](https://github.com/HJewkes/voltras-mcp/blob/main/docs/channel-plugin-packaging.md) records how they were
verified.
:::

One-time setup, from the repo root:

```bash
claude plugin marketplace add "$PWD"     # an absolute path; "." is rejected
claude plugin install voltras-channel@voltras-local
echo "$PWD" > ~/.voltras/mcp-home        # tells the plugin where this checkout is
```

You also need a machine-wide managed-settings file that allowlists the plugin.
[docs/channel-plugin-packaging.md](https://github.com/HJewkes/voltras-mcp/blob/main/docs/channel-plugin-packaging.md) has that file and
the reasons for the packaging. ([README.md § Optional: the voltra-pt launcher](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#optional-the-voltra-pt-launcher))

Then run it. The README suggests an alias:

```bash
echo "alias lift='$PWD/scripts/voltra-pt'" >> ~/.zshrc && source ~/.zshrc

lift                                    # default PT prompt
lift "let's do a back day"              # custom starting prompt
lift --print "list my sessions today"   # non-interactive query
```

`VOLTRA_PT_PROMPT` changes the default prompt. ([README.md § Optional: the voltra-pt launcher](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#optional-the-voltra-pt-launcher))

The launcher runs the server as the `voltras-channel` plugin and passes
`--channels plugin:voltras-channel@voltras-local` to Claude Code (`scripts/voltra-pt`). It
stops without launching when the `claude` command is not on your `PATH`, or when the
pre-flight below reports a failure. In this mode it also stops, and prints the fix, in these
cases:

- The `voltras-channel` plugin is not installed.
- A standalone `voltras` server is also registered with `claude mcp add`. The plugin ships
  its own server, so the two would run against the same database. Run
  `claude mcp remove voltras` to clear it.

Before it launches, the script runs the bench pre-flight. It first rebuilds the `whisper`
binary if `npm ci` removed it (`scripts/ensure-whisper.mjs`). The pre-flight then prints one
line per check: voice, Node version, push channel, spoken cues, dashboard port, and whether
the database is newer than the build. Three results stop the launch: a missing `whisper`, a
Node that is too old, and a database newer than the build. The others print a warning.
`VOLTRA_PT_SKIP_PREFLIGHT=1` skips the pre-flight.
(`scripts/preflight.mjs`, `scripts/lib/preflight-gates.mjs`)

### Why not the development-channel flag

`VOLTRA_PT_DEV=1` makes the script fall back to a `claude mcp add`ed server plus
`--dangerously-load-development-channels`. That flag needs an approval dialog. In a
scripted session nobody answers the dialog, so the channel registers nothing and push
events silently fall back to polling. The pre-flight warns about it for that reason.
([docs/bench-preflight.md](https://github.com/HJewkes/voltras-mcp/blob/main/docs/bench-preflight.md), [README.md § Optional: the voltra-pt launcher](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#optional-the-voltra-pt-launcher))

## Defaults for every launch: .launch.env

Copy `.launch.env.example` to `.launch.env` at the repo root. The file is gitignored. The
launcher exports every variable it sets into the server's environment, so you do not need
to export them in your shell. ([README.md § .launch.env](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#launchenv))

```bash
cp .launch.env.example .launch.env
```

## just recipes

`just` is optional. Each recipe wraps commands you can run directly instead (`justfile`).
([README.md § just recipes](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#just-recipes))

| Recipe           | Plain command                                          |
| ---------------- | ------------------------------------------------------ |
| `just build`     | `npm run build`                                        |
| `just dashboard` | `npm run build:dashboard`                              |
| `just test`      | `npm test`                                             |
| `just typecheck` | `npm run typecheck`                                    |
| `just lint`      | `npm run lint`                                         |
| `just sim`       | mock adapter, dashboard off, scratch database          |
| `just bench`     | `node scripts/preflight.mjs`, then the plugin launcher |

## Registering directly in ~/.claude.json

You can point Claude Code at the launcher script without installing the plugin. Add this
entry to the `mcpServers` map in your own `~/.claude.json`:

```json
"voltras": {
  "command": "/absolute/path/to/voltras-mcp/plugins/voltras-channel/bin/voltras-mcp-launch.sh",
  "env": { "VOLTRAS_MCP_HOME": "/absolute/path/to/voltras-mcp" }
}
```

A server registered this way can never be allowlisted for the push channel, so events fall
back to polling. For push events, install the `voltras-channel` plugin instead.
([README.md § Registering directly via ~/.claude.json](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#registering-directly-via-claudejson))

Because `VOLTRA_PT` is not set on this route, the launcher turns the dashboard off unless
you set `VMCP_DASHBOARD_PORT` in the `env` block or in `.launch.env`
(`plugins/voltras-channel/bin/voltras-mcp-launch.sh`).

## Running more than one instance

Every Claude Code session starts its own `voltras-mcp` process. Two processes with default
settings collide in two places. ([README.md § Running more than one instance](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#running-more-than-one-instance))

- **Port 7723.** The second dashboard cannot bind it, so it binds an OS-assigned port and
  logs both. Ask [`server.health`](/reference/server) for this session's `dashboardUrl`
  (`src/dashboard/server.ts`).
- **The SQLite file.** Both processes open `~/.voltras/vmcp.sqlite`. On open, the store runs
  one write-lock probe. The probe rejects the newcomer only if the first process holds a
  write lock at that moment. Otherwise both open, and their later concurrent writes fail
  (`src/store/sqlite-store.ts`). Keeping one process per database path is your job.

Give each parallel session its own `VMCP_DB_PATH` and `VMCP_DASHBOARD_PORT`:

```bash
claude mcp add voltras-b \
  -e VMCP_DB_PATH=/Users/you/.voltras/vmcp-b.sqlite \
  -e VMCP_DASHBOARD_PORT=7724 \
  -- node "$PWD/dist/bin.js"
```
