---
diataxis: how-to
audience: [lifter, developer]
status: available
sources:
  - README.md
  - src/tools/server-tools.ts
  - src/dashboard/server.ts
  - scripts/ensure-whisper.mjs
  - scripts/store/store-portable-cli.ts
  - src/store/__tests__/portable-round-trip.test.ts
  - package.json
  - .gitignore
lastVerified: 2026-09-27
---

# Troubleshooting

This page restates the README's
[Troubleshooting](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#troubleshooting),
[Backing up the training store](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#backing-up-the-training-store) and
[Startup latency](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#startup-latency) sections. Most checks start with
[`server.health`](/reference/server): ask Claude to call it and read the field named below.

## Common failures

### device.scan finds nothing

Wake the device screen first, because a sleeping unit does not advertise. Then check the
macOS Bluetooth permission for the app that launched the server, your terminal or Claude
Code, under System Settings, Privacy & Security, Bluetooth. Then confirm the native BLE
module built. It is an optional dependency, so a failed build is silent at install time.
([README.md § Troubleshooting](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#troubleshooting), [§ Option A](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#option-a-with-a-voltra))

### Tool calls return STARTING

The server has not finished starting. Retry after a second.
([README.md § Troubleshooting](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#troubleshooting))

The server connects first: the MCP transport is live at once, and the BLE adapter and the
SQLite store start up behind it. During that window every tool call returns a structured
`STARTING` error instead of blocking. Expect the server to be ready in under a second with
the mock adapter, and in about one to two seconds with a real device while Bluetooth comes
up. ([README.md § Startup latency](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#startup-latency))

### /app shows "SPA not built"

Run `npm run build:dashboard`. ([README.md § Troubleshooting](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#troubleshooting))

### The dashboard is unreachable

You are probably on the wrong port. Another instance holds 7723, so this session fell back
to an OS-assigned port. Call `server.health` and read `dashboardUrl`, or check stderr,
where the dashboard logs the URL it bound. A null `dashboardUrl` means
`VMCP_DASHBOARD_PORT` is `off` or the bind failed outright.
([README.md § Troubleshooting](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#troubleshooting))

If you started the server through the plugin launcher without `scripts/voltra-pt`, the
launcher turns the dashboard off by default. [Launch options](/start/launch-options#the-launcher-script)
explains when.

### Nothing works and the error mentions node:sqlite

Your Node is older than 22.5.0. Upgrade Node and restart the server.
([README.md § Troubleshooting](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#troubleshooting))

### Voice input hears nothing

Call `server.health` and read `voiceReady`. A false `whisperCli` means `npm ci` removed the
compiled binary (VW-155). Run `node scripts/ensure-whisper.mjs` to rebuild it. The rebuild
needs cmake. ([README.md § Troubleshooting](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#troubleshooting))

### No spoken cues

Call `server.health` and read `cues` and `cuesMidSet`. Both default to `off`, and cues work
on macOS only. `system.set_cues` turns either one on without a restart. The mid-set
categories, `target_hit` and `slowdown`, need both on.
([README.md § Troubleshooting](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#troubleshooting))

## Back up the training store

`npm run store` exports the SQLite store to plain text, rebuilds a store from that text, and
proves the two match. The README calls it the backup, the exit, and the first half of any
later move to another database engine.
([README.md § Backing up the training store](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#backing-up-the-training-store))

```bash
npm run store -- export <store-file> <out-dir>          # read-only; one .jsonl per table + manifest.json
npm run store -- import <in-dir> <new-store-file>       # refuses to overwrite an existing file
npm run store -- verify <store-file> <dir-or-store>     # non-zero exit on any difference
```

The export writes one newline-delimited JSON file per table, with rows in primary-key order
and columns in schema order. It adds a `manifest.json` with the schema version, the table
list, a row count per table and a SHA-256 hash per file. The export carries no timestamp, so
two exports of an unchanged store are byte-identical. `verify` prints counts and hashes,
never a stored value.
([README.md § Backing up the training store](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#backing-up-the-training-store))

`export` records the schema version the file is at. `import` needs a build that creates
exactly that version, and refuses a mismatch rather than guessing. To bring forward a store
that an upgrade left behind, start the server on it once, then export. The loader only
inserts rows, which is how it respects the store's append-only tables without switching
their guards off. Foreign keys stay enforced, deferred to the end of the single transaction
the load runs in.
([README.md § Rehearsing on a copy](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#rehearsing-on-a-copy))

## Rehearse on a copy

Rehearse on a copy of the live store, never on the live file. Stop every `voltras-mcp`
process first, so that you do not copy the file mid-write.
([README.md § Rehearsing on a copy](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#rehearsing-on-a-copy))

```bash
mkdir -p .store-scratch
cp ~/.voltras/vmcp.sqlite .store-scratch/copy.sqlite

npm run store -- export .store-scratch/copy.sqlite .store-scratch/export
npm run store -- import .store-scratch/export .store-scratch/restored.sqlite
npm run store -- verify .store-scratch/copy.sqlite .store-scratch/restored.sqlite
npm run store -- verify .store-scratch/copy.sqlite .store-scratch/export

rm -rf .store-scratch
```

`.store-scratch/` is gitignored. An export of the real store holds your whole training record
in plain text. Keep it where the store itself lives, and delete a rehearsal's copy when the
rehearsal ends. ([README.md § Rehearsing on a copy](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#rehearsing-on-a-copy))

For contributors: after any schema change, rebase onto `main` and rerun the round-trip tests
(`npx vitest run src/store/__tests__/portable-round-trip.test.ts`). Their guard is
table-level. A new table fails loudly, but a new column on an existing table does not, so
extend the fixture by hand for one. ([README.md § Rehearsing on a copy](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#rehearsing-on-a-copy))
