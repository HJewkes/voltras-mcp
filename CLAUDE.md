# voltras-mcp

MCP (Model Context Protocol) server that exposes Voltra device control, session/set/rep recording, history, and analytics as tools and resources for Claude. Stdio transport only; one process per Claude Code session.

## Per-Repo Commands

- `npm test` — run Vitest unit tests
- `npm run lint` — ESLint 9 flat config
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — emit `dist/` (the `voltras-mcp` bin)
- `npm run format` / `npm run format:check` — Prettier (globs are `src/**` and `scripts/**` only; markdown is not format-gated)
- `npm run docs:captures` — regenerate the published dashboard screenshots (needs a one-time `npx playwright@1.63.0 install chromium`; see `docs/screenshot-harness.md`)
- `npm run dashboard:preview -- <goals|body|plan>` — open one wall page on a seeded scratch store and hold it; `goals` takes `--state` (see `src/docs/preview-seeds.ts`)

**Tests run in UTC.** `vitest.config.ts` pins `process.env.TZ = 'UTC'`, which is what CI runs, so a fixture written as a UTC instant reads the same on any machine. Goal weeks, block calendars and `history.trend` buckets are LOCAL weeks, so a green run west of UTC proves nothing about local-time behaviour unless the file pins its own zone: set `process.env.TZ` before the first import, and restore it in `afterAll` (`src/plan/__tests__/block-calendar-local-time.test.ts`, `src/tools/__tests__/goal-targets-on-blocks.test.ts`). The docs site is built in CI (`npm run docs:build`) and is not part of the CI gate below: a rendered tool description containing an angle-bracket placeholder fails it (VitePress parses it as HTML).

CI gate: lint + typecheck + test + build. The pre-commit hook runs `lint-staged` only; `.husky/pre-push` runs `prettier --check` over files changed vs `origin/main` under `src/**`, `scripts/**`, or `site/**` markdown. Typecheck and the full test suite run in CI, not locally.

## Adapter Modes

- `VOLTRA_ADAPTER=node` (default) — real BLE via `@voltras/node-sdk`. Requires macOS Bluetooth permission for the running shell / terminal app. The first connect prompt may appear in System Settings -> Privacy & Security -> Bluetooth.
- `VOLTRA_ADAPTER=mock` — in-memory device with deterministic frames; safe for CI and local dev without a device. Adds `mock.configure` and `mock.inject_error` tools.

Adapter is read once at startup; runtime switching is out of scope for v1.

## Environment Variables

| Var                  | Default                  | Notes                                                                                                                                     |
| -------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `VOLTRA_ADAPTER`     | `node`                   | `node` or `mock`                                                                                                                          |
| `VMCP_DB_PATH`       | `~/.voltras/vmcp.sqlite` | SQLite store path; don't share one path across processes — startup runs a best-effort lock probe (see Concurrency), not a persistent lock |
| `VMCP_LOG_LEVEL`     | `info`                   | `debug` / `info` / `warn` / `error`; logs go to stderr only (stdio is reserved for MCP transport)                                         |
| `VMCP_REST_TIMER`    | `off`                    | `off` / `on`; opt-in auto `rest_status` cycle on natural set close (VMCP-02.54). Never armed on a `session.end` cascade                   |
| `VMCP_AUTO_ARM`      | `on`                     | `off` / `on`; open a set on the lifter's own reps during an open session and count them into it (VW-164, VW-181)                          |
| `VOLTRAS_EFFORT_CUE` | `off`                    | `off` / `on`; the effort rule decides the one mid-set ending cue and stores a cue record with the set (VW-544). Off until the bench       |

## Concurrency

Stdio is single-client by transport design — each Claude Code session spawns its own `voltras-mcp` process. Keep one process per `VMCP_DB_PATH`: that is a caller responsibility, not something the store enforces. On open the store runs a single `BEGIN IMMEDIATE` write-lock probe, so a newcomer is rejected with a clear lock error **only if the incumbent happens to hold a write lock at that instant**. It is not a persistent lock (the DB is not in WAL mode), so two processes that both open while neither is mid-write will both succeed — their later concurrent writes then fail with a `SQLITE_BUSY`-style error. The probe catches the common case; it is not a guarantee.

## Source-Layout Conventions

- `src/bin.ts` — process entry, defers to `src/server.ts`
- `src/server.ts` — MCP server bootstrap (peer task)
- `src/tools/` — domain-grouped tool modules (`device.*`, `session.*`, `set.*`, `metrics.*`, `exercise.*`, `mock.*`)
- `src/resources/` — `voltra://device/current`, `voltra://session/active`, `voltra://set/active`
- `src/state/` — in-process `LiveState` collector + SDK `event-bridge`
- `src/store/` — `node:sqlite`-backed `SessionStore`
- `src/docs/` — pure renderers + confidentiality guard behind `npm run docs:reference`, the screenshot definition behind `npm run docs:captures`, and the preview seeds behind `npm run dashboard:preview`
- `src/errors.ts` — shared `errorResult` / `textResult` helpers
- `eslint-rules/` — repo-local ESLint rules loaded by `eslint.config.mjs`
- `plugins/voltras-channel/` — the installable plugin: launcher shim and the `pt-session` coach skill. Its `references/15-tool-inventory.md` is generated by `npm run docs:reference`; edit `src/docs/skill-inventory-notes.ts` instead

## Confidentiality / Privacy

**Why this exists.** Beyond Power shared the device's internals informally to help the community SDK, and asked that they not be shared publicly. That is a **confidentiality boundary** — a trust commitment, not a signed agreement. Write "confidentiality boundary"; never write "NDA", because nothing was signed.

**The rule.** No device value, byte, frame payload, command code, register name, offset, or pointer into a non-public tree may appear in:

- source, comments (including trailing ones), string literals or identifiers
- tool inputs, outputs, schemas or descriptions
- log lines or error messages
- commit messages, PR titles or PR bodies

Describe the observable behaviour instead. Protocol-derived findings belong in `voltra-private/research/`, not here.

**What enforces it, and what does not.**

| layer                                          | covers                                                                                                                    | runs                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `voltras/no-protocol-detail` (`eslint-rules/`) | encoded values and provenance in `src/**`: hex literals, byte sequences, bare hex runs, command codes, private-tree paths | `npm run lint`, CI                       |
| NF-07 (`eslint.config.mjs`)                    | `Buffer.*` inside any `*Handler` function                                                                                 | `npm run lint`, CI                       |
| `src/docs/protocol-guard.ts`                   | protocol-shaped tokens on generated documentation pages                                                                   | `npm run docs:reference`, `npm test`, CI |
| `scripts/check-nul-bytes.mjs`                  | a literal NUL byte anywhere under `src/`, `scripts/`, `docs/`, `tools/` or `packages/` — the byte that hid VW-213's finding from `grep -r` in the first place | `npm run check:nul-bytes`, CI            |

**Prose is not covered, and no rule will cover it.** A sentence that names a register and describes what writing to it does carries no value in any shape a pattern can match, and a partial redaction is worse than none: `[redacted]` next to an intact mechanism sentence reads as a decision someone already made rather than as an oversight (VW-220). So prose is a **review-checklist item**: when a change touches device behaviour, read the prose and ask whether a reader could reconstruct anything from it.

**Three lint exemption directives exist**, all in `uint8ArrayToHex` (`src/tools/device-tools.ts`), all inline with a stated reason, and the full set is pinned by `src/__tests__/lint/no-protocol-detail.test.ts`. Adding a third means editing that pin and saying why. `reportUnusedDisableDirectives` is `error`, so a directive left behind after its line changed fails the build.

The 15 test files under `src/**/__tests__/` still hold protocol fixtures and are exempt by path (w5-13). The exemption is a path glob in `eslint.config.mjs`; it governs what is fixed, never what is counted.

## Gotchas

- `ci.yml` runs only on PRs whose base is `main`: a stacked PR gets no checks, and retargeting it to `main` does not start them (close and reopen does).
- PRs are squash-merged, so after a parent PR lands, rebase a stacked branch with `git rebase --onto origin/main <old-parent-sha>` and check `git diff --name-only origin/main...HEAD`.
- `pages.yml` runs `docs:build` on PRs only when `site/**` changes, but the site includes the root `CHANGELOG.md`; run `npm run docs:build` for any docs or CHANGELOG change, and write CHANGELOG links site-relative (`/guides/x`), not as repo paths. `docs:check` does not catch dead links.
- The docs protocol guard (`src/docs/protocol-guard.ts`) rewrites any ALL-CAPS-HYPHENATED token to `[redacted]` in generated pages while `docs:check` still passes; avoid that emphasis in tool descriptions and grep the regenerated `site/reference/` diff for `[redacted]`.
- `security-audit` blocks only on critical vulns (`--audit-level=critical`), and they sit in the production tree (`@modelcontextprotocol/sdk`, `onnxruntime-node`), so `--omit=dev` does not help; try plain `npm audit fix` first.
- Never regenerate `package-lock.json` on macOS: npm drops the Linux-only `@emnapi/*` optional peers and CI's `npm ci` fails. Bump a dependency by editing its lockfile entries (range, version, `resolved`, `integrity`) by hand.
- The main checkout is the pinned bench build: never `npm install` there. Worktrees under `.worktrees/` without their own `node_modules` resolve up to it, so run `npm ci` in the worktree before believing a local failure CI does not show.
- The SPA consumes `@titan-design/react-ui` from npm at a caret pin, so a titan component merged to titan `main` is unavailable here until a titan release is tagged and published.
- In the dashboard SPA, react-native-web's base `View` rules silently beat Tailwind layout classes (`flex-1`, `flex-row`, `items-center`); put layout in `style` props and keep colour classes in `className`.
- `@voltras/workout-analytics` typings degrade `Set.reps` to `readonly any[]` under NodeNext; import `Rep` directly and annotate callbacks (`set.reps.map((rep: Rep) => ...)`).
- Upserts on a parent row with FK children use `INSERT ... ON CONFLICT DO UPDATE`, never `INSERT OR REPLACE`, which deletes and reinserts the row and cascade-wipes its children.
- Migrations: probe columns with `table_xinfo` (`table_info` omits generated columns); create indexes over new columns inside the migration, because `SCHEMA_SQL` runs first; keep backticks out of SQL comments in `SCHEMA_SQL`; an explicitly bound `NULL` overrides a column `DEFAULT`.
- A fresh store and a migrated store can hold the same columns in different physical positions; sort columns by name in any store-to-store comparison (`src/store/portable/inventory.ts`).
- Opening `~/.voltras/vmcp.sqlite` through `SessionStore` migrates it; a read-only tool copies the file into a gitignored scratch dir and opens the copy with `node:sqlite` `readOnly: true` (see `scripts/sim/`).
- There is no `tsx` or `ts-node`: a TypeScript script compiles through its own tsconfig into a gitignored build dir (`tsconfig.sim.json` to `.sim-build/`), and `npm run lint` does not cover `scripts/`.
- `VMCP_DASHBOARD_PORT=0` turns the dashboard off (like `off`); it is not an ephemeral port. On a held port the sidecar falls back to an OS-assigned one, so read the URL from `server.health.dashboardUrl`, which ends in `/app`.
