# voltras-mcp

MCP (Model Context Protocol) server that exposes Voltra device control, session/set/rep recording, history, and analytics as tools and resources for Claude. Stdio transport only; one process per Claude Code session.

## Per-Repo Commands

- `npm test` — run Vitest unit tests
- `npm run lint` — ESLint 9 flat config
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — emit `dist/` (the `voltras-mcp` bin)
- `npm run format` / `npm run format:check` — Prettier

CI gate: lint + typecheck + test + build. The pre-commit hook runs lint-staged + typecheck + `vitest related` on staged files (full suite stays in CI).

## Adapter Modes

- `VOLTRA_ADAPTER=node` (default) — real BLE via `@voltras/node-sdk`. Requires macOS Bluetooth permission for the running shell / terminal app. The first connect prompt may appear in System Settings -> Privacy & Security -> Bluetooth.
- `VOLTRA_ADAPTER=mock` — in-memory device with deterministic frames; safe for CI and local dev without a device. Adds `mock.configure` and `mock.inject_error` tools.

Adapter is read once at startup; runtime switching is out of scope for v1.

## Environment Variables

| Var              | Default                  | Notes                                                                                                                                     |
| ---------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `VOLTRA_ADAPTER` | `node`                   | `node` or `mock`                                                                                                                          |
| `VMCP_DB_PATH`   | `~/.voltras/vmcp.sqlite` | SQLite store path; don't share one path across processes — startup runs a best-effort lock probe (see Concurrency), not a persistent lock |
| `VMCP_LOG_LEVEL` | `info`                   | `debug` / `info` / `warn` / `error`; logs go to stderr only (stdio is reserved for MCP transport)                                         |

## Concurrency

Stdio is single-client by transport design — each Claude Code session spawns its own `voltras-mcp` process. Keep one process per `VMCP_DB_PATH`: that is a caller responsibility, not something the store enforces. On open the store runs a single `BEGIN IMMEDIATE` write-lock probe, so a newcomer is rejected with a clear lock error **only if the incumbent happens to hold a write lock at that instant**. It is not a persistent lock (the DB is not in WAL mode), so two processes that both open while neither is mid-write will both succeed — their later concurrent writes then fail with a `SQLITE_BUSY`-style error. The probe catches the common case; it is not a guarantee.

## Source-Layout Conventions

- `src/bin.ts` — process entry, defers to `src/server.ts`
- `src/server.ts` — MCP server bootstrap (peer task)
- `src/tools/` — domain-grouped tool modules (`device.*`, `session.*`, `set.*`, `metrics.*`, `exercise.*`, `mock.*`)
- `src/resources/` — `voltra://device/current`, `voltra://session/active`, `voltra://set/active`
- `src/state/` — in-process `LiveState` collector + SDK `event-bridge`
- `src/store/` — `node:sqlite`-backed `SessionStore`
- `src/errors.ts` — shared `errorResult` / `textResult` helpers
- `src/types/` — non-test type-only modules (excluded from coverage)

## NDA / Privacy

No protocol bytes, raw frame payloads, or proprietary command codes may appear in any tool input, output, schema, log line, error message, or commit. ESLint flags `Buffer.*` references inside any function whose name ends with `Handler` (NF-07). Only typed values from the SDK's public surface cross the MCP boundary.
