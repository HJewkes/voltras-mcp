---
diataxis: how-to
audience: [lifter, developer]
status: available
sources:
  - README.md
  - src/tools/server-tools.ts
  - src/dashboard/server.ts
  - src/server.ts
  - src/client-connection.ts
  - src/voice/cue-emitter.ts
  - src/store/portable/inventory.ts
  - src/store/portable/import.ts
  - scripts/ensure-whisper.mjs
  - scripts/store/store-portable-cli.ts
  - src/store/__tests__/portable-round-trip.test.ts
  - package.json
  - .gitignore
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Troubleshooting

Most checks start with
[`server.health`](/reference/server): ask Claude to call it and read the field named below.

## Common failures

### device.scan finds nothing

Wake the device screen first, because a sleeping unit does not advertise. Then check the
macOS Bluetooth permission for the app that launched the server, your terminal or Claude
Code, under System Settings, Privacy & Security, Bluetooth. Then confirm the native BLE
module built. It is an optional dependency, so a failed build is silent at install time.

### Tool calls return STARTING

The server has not finished starting. Retry after a second.

The server connects first: the MCP transport is live at once, and the BLE adapter and the
SQLite store start up behind it. During that window every tool call returns a structured
`STARTING` error instead of blocking. Expect the server to be ready in under a second with
the mock adapter, and in about one to two seconds with a real device while Bluetooth comes
up.

### /app shows "SPA not built"

Run `npm run build:dashboard`.

### The dashboard is unreachable

You are probably on the wrong port. Another instance holds 7723, so this session fell back
to an OS-assigned port. Call `server.health` and read `dashboardUrl`, or check stderr,
where the dashboard logs the URL it bound at the `info` log level. A null `dashboardUrl`
means `VMCP_DASHBOARD_PORT` is `off` or `0`, or the bind failed outright.

If you started the server through the plugin launcher without `scripts/voltra-pt`, the
launcher turns the dashboard off by default. [Launch options](/start/launch-options#the-launcher-script)
explains when. [Set it up and open it](/guides/dashboard-setup#when-it-does-not-open) walks
through each way the dashboard fails to open.

### Nothing works and the error mentions node:sqlite

Your Node is older than 22.13.0, the first 22.x release that loads `node:sqlite` without a flag.
Upgrade Node and restart the server.

### Voice input hears nothing

Call `server.health` and read `voiceReady`. A false `whisperCli` means `npm ci` removed the
compiled binary (VW-155). Run `node scripts/ensure-whisper.mjs` to rebuild it. The rebuild
needs cmake.

### No spoken cues

Call `server.health` and read `cues` and `cuesMidSet`. Both default to `off`, and cues work
on macOS only. `system.set_cues` turns either one on without a restart. The mid-set
categories, `target_hit` and `slowdown`, need both on. With `cuesMidSet` set to `risk`, they
speak only when `VMCP_CUE_DELIVERY=on`, and only on a set read as green.

## Back up the training store

`npm run store` exports the SQLite store to plain text, rebuilds a store from that text, and
proves the two match. It is the backup, the exit, and the first half of any
later move to another database engine.

```bash
npm run store -- export <store-file> <out-dir>          # read-only; one .jsonl per table + manifest.json
npm run store -- import <in-dir> <new-store-file>       # refuses to overwrite an existing file
npm run store -- verify <store-file> <dir-or-store>     # non-zero exit on any difference
```

The export writes one newline-delimited JSON file per table, with rows in primary-key order
and columns sorted by name. A migrated store and a fresh one can hold the same columns in
different positions, and name order lets the two compare equal. Generated columns are left
out of the files, because SQLite computes them. It adds a `manifest.json` with the schema version, the table
list, a row count per table and a SHA-256 hash per file. The export carries no timestamp, so
two exports of an unchanged store are byte-identical. `verify` prints counts and hashes,
never a stored value.

`export` records the schema version the file is at. `import` needs a build that creates
exactly that version, and refuses a mismatch rather than guessing. To bring forward a store
that an upgrade left behind, start the server on it once, then export. The loader only
inserts rows, which is how it respects the store's append-only tables without switching
their guards off. Foreign keys stay enforced, deferred to the end of the single transaction
the load runs in.

## Rehearse on a copy

Rehearse on a copy of the live store, never on the live file. Stop every `voltras-mcp`
process first, so that you do not copy the file mid-write.

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
rehearsal ends.

For contributors: after any schema change, rebase onto `main` and rerun the round-trip tests
(`npx vitest run src/store/__tests__/portable-round-trip.test.ts`). Their guard is
table-level. A new table fails loudly, but a new column on an existing table does not, so
extend the fixture by hand for one.

## Make a private anonymised fixture

`anonymize` turns an export into a fixture shaped like your own training, for running the
server or the dashboard against realistic history on your own machine. Load the result with
`import` into a new store file.

```bash
npm run store -- export ~/.voltras/vmcp.sqlite ~/.voltras/fixtures/export
npm run store -- anonymize ~/.voltras/fixtures/export [out-dir] [--seed N] [--scale]
npm run store -- import ~/.voltras/fixtures/export-anonymized ~/.voltras/fixtures/anon.sqlite
rm -rf ~/.voltras/fixtures/export
```

What it changes:

- Free text is removed: notes, the display name, commitment wording, self-report text,
  limitation notes, setup labels, profile answers and similar fields.
- Program, block, week and workout names become `Program 1`, `Block 1`, `Week 1`, `Workout A`
  and so on. Exercises outside the built-in catalog become `Custom exercise N`.
- Device ids, external ids and lifter labels become salted-hash stand-ins.
- Rep records keep their per-phase summaries and derived metrics, without the raw samples.
- Device events, idle reps, coaching-cue state, the action log and the accountability send
  history are left out.
- Every date moves back by the same whole number of weeks, so weekdays and local times of day
  stay the same. `--scale` multiplies every load by one factor between 0.9 and 1.1.
- `--seed N` makes a rerun write the same files.

Every table and column must have a rule. If a later version adds one without a rule, the run
stops before it writes anything. The output goes to `~/.voltras/fixtures/` unless you name a
directory. It refuses any directory inside a git work tree.

**The output is still your personal training data.** It holds your real sessions, loads and
body measurements. Never commit it, attach it to an issue, or share it.
