# @voltras/session-core

Framework-agnostic shared workout-state layer for the Voltras ecosystem. Phase-1
scaffold — **VMCP-03.01**.

Two codebases produce and consume live workout state today: the `voltras-mcp` web
dashboard (server-side compute → projected snapshot) and the `voltras/mobile` app
(client-side zustand). The domain math is already shared via
[`@voltras/workout-analytics`](https://www.npmjs.com/package/@voltras/workout-analytics)
(`WorkoutSample` is the universal atom); what diverges is the lifecycle/orchestration
shell and the transport feeding it. This package formalizes the two seams both sides
already expose informally.

## What's here (Phase 1)

| Module           | Export                                                                      | Role                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data-source.ts` | `WorkoutDataSource`, `WorkoutControl`                                       | Seam 1 — per-device transport at `WorkoutSample` grain. `control` optional (BLE has it; dashboard SSE read-only until the Phase-2 mutation API). |
| `repository.ts`  | `SessionRepository`, `SessionCodec`, `ConnectTransportToRecording`          | Seam 2 — document-oriented, lifecycle-only persistence. Planning tree stays platform-side.                                                       |
| `canonical.ts`   | `CanonicalWorkoutSession`, `CanonicalSet`, `CanonicalRepMeta`               | The shared in-memory model — NESTED over WA types, epoch-ms timestamps.                                                                          |
| `codecs/`        | `mcpCodec`, `mobileCodec`, `detectMcpLossyLoad`, `canonicalSetToMobileReps` | Reference codecs between each platform's stored shape and the canonical model, with round-trip tests.                                            |

The three known lossy directions are documented and tested (`codecs/__tests__/roundtrip.test.ts`):

- **`chains`/`eccentric` — MCP-lossy** (no columns; flattens to one `weightLbs`). Use
  `detectMcpLossyLoad` before a write.
- **per-rep `derivedVbt` — mobile-lossy** (mobile reps carry only raw samples). Lives in
  `repMeta[]`, never spread onto the WA `Rep` (`satisfies Rep` invariant).
- **`plan` ⇄ `program_assignments` — never cross** (two different concepts; namespaced in `extra`).

## Boundaries

- **SDK-free by construction**: everything is at the `WorkoutSample` (fitness-unit) grain,
  never `TelemetryFrame` / protocol bytes (NDA / ESLint NF-07).
- **No platform code yet**: no store bodies, no BLE/SSE adapters. Those land in VMCP-03.02
  (dashboard store) and the Phase-2 platform adapters. The reference stored-shapes in
  `codecs/stored-shapes.ts` mirror the real platform schemas and become the conformance
  contract those types satisfy.
- **In-repo for now**: lives under `voltras-mcp/packages/` (factored for extraction to a
  standalone published package once Stage A validates against the dashboard).

## Develop

```sh
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run build        # tsc -> dist/
```

Design: `coordination/architecture/state-layer-convergence-2026-07-12.md` (§3a/§3b/§3d) and
`session-core-roundtrip-spec.md` in the voltras-workspace.
