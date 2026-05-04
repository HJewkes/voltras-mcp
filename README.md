# voltras-mcp

MCP (Model Context Protocol) server exposing Voltra device control, workout/session recording, history, and analytics to Claude Code. Stdio transport only; the binary is registered as `voltras-mcp` and launched via `npx voltras-mcp` (or via `claude mcp add`).

## Setup

Requires Node >= 22.5.0 (the server uses `node:sqlite`).

```bash
# Register with Claude Code (uses npx; pulls the published package)
claude mcp add voltras -- npx voltras-mcp

# Local development (clone + link)
git clone <remote> ~/Documents/projects/voltras-mcp
cd ~/Documents/projects/voltras-mcp
npm install
npm run build
npm link
claude mcp add voltras -- voltras-mcp
```

Restart Claude Code after registration; resources and tools appear under the `voltras` MCP server.

## Environment Variables

| Var              | Default                  | Allowed                                | Purpose                                                                             |
| ---------------- | ------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `VOLTRA_ADAPTER` | `node`                   | `node` \| `mock`                       | BLE adapter selection. `mock` adds the `mock.*` tools and uses an in-memory device. |
| `VMCP_DB_PATH`   | `~/.voltras/vmcp.sqlite` | absolute path                          | SQLite store location. The directory is created if missing.                         |
| `VMCP_LOG_LEVEL` | `info`                   | `debug` \| `info` \| `warn` \| `error` | Log verbosity. All logs go to stderr; stdio is reserved for the MCP transport.      |

## Concurrency

Stdio is a single-client transport. Each Claude Code session spawns its own `voltras-mcp` process. If two processes target the same `VMCP_DB_PATH`, the second detects SQLite write-lock contention at startup and exits with a clear error message naming the path. Use distinct `VMCP_DB_PATH` values when running multiple sessions in parallel.

## Startup Latency

Server is connect-first: `server.connect(transport)` returns immediately, after which the BLE adapter and SQLite store bootstrap. During the bootstrap window (~hundreds of ms), tool calls return a structured `STARTING` error result rather than blocking. Once bootstrap completes, real handlers replace the placeholders. Adapter init is the dominant cost; expect sub-second readiness in mock mode and 1-2 seconds in node mode while BLE comes up.

## Tool Catalog

20 tools across five always-on namespaces plus an optional `mock.*` namespace.

### Device (`device.*`)

| Tool                   | Purpose                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| `device.scan`          | Discover nearby Voltra devices. Optional `timeoutMs` (default 10000, min 1000). |
| `device.connect`       | Connect to a discovered device by id.                                           |
| `device.disconnect`    | Disconnect from the active device.                                              |
| `device.set_weight`    | Set target weight (kg).                                                         |
| `device.set_mode`      | Set training mode.                                                              |
| `device.set_chains`    | Configure chain settings.                                                       |
| `device.set_eccentric` | Configure eccentric overload.                                                   |
| `device.get_state`     | Read current device snapshot from `LiveState`.                                  |

### Session + Query (`session.*`)

| Tool            | Purpose                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `session.start` | Begin a session. Provide exactly one of `exerciseId` (catalog-validated) or `exerciseName` (free-text). |
| `session.end`   | Finalize the active session (auto-closes any active set as `partial: true`).                            |
| `session.list`  | List persisted sessions. `sort` accepts `startedAt:desc` (default) or `startedAt:asc`.                  |
| `session.get`   | Fetch a single session by id, including its sets.                                                       |

### Set (`set.*`)

| Tool               | Purpose                                                     |
| ------------------ | ----------------------------------------------------------- |
| `set.start`        | Begin a set inside the active session.                      |
| `set.end`          | End and persist the active set.                             |
| `set.live_metrics` | Read live metrics for the in-progress set from `LiveState`. |

### Analytics (`metrics.*`)

| Tool              | Purpose                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics.compute` | Run an analytics pipeline (`pipeline` enum) against a session id, set id, or set-id array. Dispatches to `@voltras/workout-analytics` — no analytics logic re-implemented locally. |

### Exercise (`exercise.*`)

| Tool              | Purpose                                       |
| ----------------- | --------------------------------------------- |
| `exercise.search` | Search the workout-analytics catalog by name. |
| `exercise.get`    | Fetch a catalog `Exercise` by id.             |

### Mock (`mock.*`, registered iff `VOLTRA_ADAPTER=mock`)

| Tool                | Purpose                                             |
| ------------------- | --------------------------------------------------- |
| `mock.configure`    | Apply mock-device parameters (battery, RSSI, mode). |
| `mock.inject_error` | Inject an error condition for adapter-error tests.  |

## Resources

Three MCP resources are always registered:

| URI                       | Body                                               |
| ------------------------- | -------------------------------------------------- |
| `voltra://device/current` | Current device snapshot from `LiveState`.          |
| `voltra://session/active` | Active session snapshot, or `{ "active": false }`. |
| `voltra://set/active`     | Active set snapshot, or `{ "active": false }`.     |

`capabilities.resources.subscribe = true`. The server emits `sendResourceUpdated({ uri })` for the specific resource whose state changed (best-effort hint; resources are polling-correct regardless).

## Privacy / NDA

No protocol bytes, raw frame payloads, or proprietary command codes appear in any tool I/O, schema, log line, or commit. Only typed values from the SDK public surface cross the MCP boundary.

## Known Issues / Follow-ups

The 16-task VMCP-01 plan is complete and all 186 unit + integration tests pass. Three production blockers were surfaced and fixed during the build-out (placeholder schema, two-client divergence on `device.connect`, Rep assembly from frame stream). The metrics schema gap (`quality.rep` + `session.readiness`) was also closed by adding baseline parameters. Two issues remain — both block on package publishes:

| #   | Issue                                                                                                                                                                                                                                              | Fix Path                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `@voltras/node-sdk@0.3.0` ESM build has bare extensionless imports + a CJS `require()` in `forMock`, plus an eager re-export of `NativeBLEAdapter` that loads `react-native-ble-plx` for non-RN consumers.                                         | **Fixed locally** on the SDK's `feat/sdk-fixes` branch (tsc-alias, eager forMock import, type-only NativeBLEAdapter root export, `./native`/`./node`/`./web` subpath exports, `dist/esm/package.json` declaring `"type": "module"`). Resolves when the SDK publishes a release with that branch. |
| 2   | `@voltras/workout-analytics@0.2.0` does not export `searchExercises` / `getExerciseById` / type `Exercise`. `state.exercises.getById('bench-press')` throws `TypeError`. Integration tests use `exerciseName` (free-text) instead of `exerciseId`. | Resolves when `@voltras/workout-analytics@1.0.0` (the WA-04 storage-layer release) publishes the catalog API. The local `feat/wa-04-pr1` branch already contains it.                                                                                                                             |

The matching SDK additions for `mock.*` are already on `feat/sdk-fixes`: a public `MockBLEAdapter.configure(partial)` plus the existing-but-not-yet-published `MockBLEAdapter.injectError(type, config)` and `VoltraManager.getAdapter()` (added in commits `#18` and `#20`). VMCP's `mock.configure` / `mock.inject_error` will go live as soon as the new SDK release is consumed.
