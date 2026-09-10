# voltras-mcp

MCP (Model Context Protocol) server that exposes Voltra device control, session/set/rep recording, history, and analytics as tools and resources for Claude. Stdio transport only; one process per Claude Code session.

## Per-Repo Commands

- `npm test` — run Vitest unit tests
- `npm run lint` — ESLint 9 flat config
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — emit `dist/` (the `voltras-mcp` bin)
- `npm run format` / `npm run format:check` — Prettier (globs are `src/**` and `scripts/**` only; markdown is not format-gated)
- `npm run docs:captures` — regenerate the published dashboard screenshots (needs a one-time `npx playwright@1.63.0 install chromium`; see `docs/screenshot-harness.md`)

CI gate: lint + typecheck + test + build. The pre-commit hook runs lint-staged + typecheck + `vitest related` on staged files (full suite stays in CI).

## Adapter Modes

- `VOLTRA_ADAPTER=node` (default) — real BLE via `@voltras/node-sdk`. Requires macOS Bluetooth permission for the running shell / terminal app. The first connect prompt may appear in System Settings -> Privacy & Security -> Bluetooth.
- `VOLTRA_ADAPTER=mock` — in-memory device with deterministic frames; safe for CI and local dev without a device. Adds `mock.configure` and `mock.inject_error` tools.

Adapter is read once at startup; runtime switching is out of scope for v1.

## Environment Variables

| Var               | Default                  | Notes                                                                                                                                     |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `VOLTRA_ADAPTER`  | `node`                   | `node` or `mock`                                                                                                                          |
| `VMCP_DB_PATH`    | `~/.voltras/vmcp.sqlite` | SQLite store path; don't share one path across processes — startup runs a best-effort lock probe (see Concurrency), not a persistent lock |
| `VMCP_LOG_LEVEL`  | `info`                   | `debug` / `info` / `warn` / `error`; logs go to stderr only (stdio is reserved for MCP transport)                                         |
| `VMCP_REST_TIMER` | `off`                    | `off` / `on`; opt-in auto `rest_status` cycle on natural set close (VMCP-02.54). Never armed on a `session.end` cascade                   |
| `VMCP_AUTO_ARM`   | `on`                     | `off` / `on`; open a set on the lifter's own reps during an open session and count them into it (VW-164, VW-181)                          |

## Concurrency

Stdio is single-client by transport design — each Claude Code session spawns its own `voltras-mcp` process. Keep one process per `VMCP_DB_PATH`: that is a caller responsibility, not something the store enforces. On open the store runs a single `BEGIN IMMEDIATE` write-lock probe, so a newcomer is rejected with a clear lock error **only if the incumbent happens to hold a write lock at that instant**. It is not a persistent lock (the DB is not in WAL mode), so two processes that both open while neither is mid-write will both succeed — their later concurrent writes then fail with a `SQLITE_BUSY`-style error. The probe catches the common case; it is not a guarantee.

## Source-Layout Conventions

- `src/bin.ts` — process entry, defers to `src/server.ts`
- `src/server.ts` — MCP server bootstrap (peer task)
- `src/tools/` — domain-grouped tool modules (`device.*`, `session.*`, `set.*`, `metrics.*`, `exercise.*`, `mock.*`)
- `src/resources/` — `voltra://device/current`, `voltra://session/active`, `voltra://set/active`
- `src/state/` — in-process `LiveState` collector + SDK `event-bridge`
- `src/store/` — `node:sqlite`-backed `SessionStore`
- `src/docs/` — pure renderers + confidentiality guard behind `npm run docs:reference`, and the screenshot definition behind `npm run docs:captures`
- `src/errors.ts` — shared `errorResult` / `textResult` helpers
- `src/types/` — non-test type-only modules (excluded from coverage)
- `eslint-rules/` — repo-local ESLint rules loaded by `eslint.config.mjs`

## Confidentiality / Privacy

**Why this exists.** Beyond Power shared the device's internals informally to help the community SDK, and asked that they not be shared publicly. That is a **confidentiality boundary** — a trust commitment, not a signed agreement. Write "confidentiality boundary"; never write "NDA", because nothing was signed.

**The rule.** No device value, byte, frame payload, command code, register name, offset, or pointer into a non-public tree may appear in:

- source, comments (including trailing ones), string literals or identifiers
- tool inputs, outputs, schemas or descriptions
- log lines or error messages
- commit messages, PR titles or PR bodies

Describe the observable behaviour instead. Protocol-derived findings belong in `voltra-private/research/`, not here.

**What enforces it, and what does not.**

| layer | covers | runs |
| --- | --- | --- |
| `voltras/no-protocol-detail` (`eslint-rules/`) | encoded values and provenance in `src/**`: hex literals, byte sequences, bare hex runs, command codes, private-tree paths | `npm run lint`, CI |
| NF-07 (`eslint.config.mjs`) | `Buffer.*` inside any `*Handler` function | `npm run lint`, CI |
| `src/docs/protocol-guard.ts` | protocol-shaped tokens on generated documentation pages | `npm run docs:reference`, `npm test`, CI |

**Prose is not covered, and no rule will cover it.** A sentence that names a register and describes what writing to it does carries no value in any shape a pattern can match, and a partial redaction is worse than none: `[redacted]` next to an intact mechanism sentence reads as a decision someone already made rather than as an oversight (VW-220). So prose is a **review-checklist item**: when a change touches device behaviour, read the prose and ask whether a reader could reconstruct anything from it.

**Three lint exemption directives exist**, all in `uint8ArrayToHex` (`src/tools/device-tools.ts`), all inline with a stated reason, and the full set is pinned by `src/__tests__/lint/no-protocol-detail.test.ts`. Adding a third means editing that pin and saying why. `reportUnusedDisableDirectives` is `error`, so a directive left behind after its line changed fails the build.

The 15 test files under `src/**/__tests__/` still hold protocol fixtures and are exempt by path (w5-13). The exemption is a path glob in `eslint.config.mjs`; it governs what is fixed, never what is counted.
