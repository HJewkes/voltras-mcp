# MCP Dashboard Data Layer

Status: **current topology + near-term target data layer** · Scope: the voltras-mcp local dashboard (`src/dashboard/`)

> **What's in place vs. planned.** The _topology_ (thin client over a server-owned
> device), the _two-transport_ model (`/api/snapshot` + `/api/stream`), and the
> _security posture_ are how the dashboard works today. The _client single-store_
> (§4) and the _server read-model extraction_ (§3) are the near-term migration
> target — the "land it cleanly" work — not yet in the tree. Sections note this
> where relevant.

## 1. Topology: a thin client over a server-owned device

The MCP process owns the Voltra BLE connection through `@voltras/node-sdk`
(a noble-family central). The browser dashboard is a **thin client**: it owns
no device connection and renders snapshots of server-held state. This is the
only sound web topology for the wall dashboard —

- **Web Bluetooth is disqualifying**: Chrome/Android-only, absent on iOS
  Safari, and cannot hold a background connection.
- A Node/noble central owns the adapter directly and runs continuously.
- The dashboard is **read-only**: device commands come from MCP _tools_
  (invoked by Claude), never from the browser. The browser→server channel is
  therefore unidirectional by nature.

```
Voltra device ──BLE──▶ node-sdk ──▶ event-bridge ──▶ LiveState (authoritative, in-memory)
                                          │                    │
                                          ├──▶ sqlite-store     ├──▶ /api/snapshot (poll: hydrate + reconcile)
                                          └──▶ LiveSignalHub ───┴──▶ /api/stream   (SSE: live deltas + overlay)
```

## 2. Two transports, one truth

State reaches the browser over two channels, by design:

| Channel  | Endpoint                | Carries                                                               | Role                                                                             |
| -------- | ----------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Snapshot | `GET /api/snapshot`     | session, per-slot device, active set + reps                           | **Source of truth.** Hydrates on load; periodic authoritative reconcile.         |
| Stream   | `GET /api/stream` (SSE) | `phase` / `phaseflip` / `rep` / `set` / lifecycle deltas + ~1 Hz `hb` | Live overlay + structural deltas. Losing it costs smoothness, never correctness. |

This is the standard real-time reconciliation shape: a **high-rate delta
stream backed by a periodic full resync**. SSE (not WebSocket) is the exact fit
because the channel is server→client only; WebSocket's bidirectional cost buys
nothing here. SSE is HTTP-native (passes proxies untouched) and auto-reconnects.

> **Target refinement.** Today `/api/snapshot` polls at 500 ms and SSE is used
> mainly as a smoothing overlay. The target is to (a) promote SSE to carry
> structural set/session/connection lifecycle deltas, and (b) slow the snapshot
> poll to a 2–5 s authoritative reconcile — snapshot becomes hydrate-and-heal,
> live truth arrives on the stream.

**Fitness-units boundary (NF-07):** the SSE schema (`state/live-signal.ts`) is
expressed only in fitness units (m/s, lbs, normalized 0–600 position, semantic
phase). No protocol bytes, frame buffers, or command codes cross the wire.

## 3. Server-side layers (ports & adapters)

| Layer                          | Module                                          | Responsibility                              |
| ------------------------------ | ----------------------------------------------- | ------------------------------------------- |
| Domain (framework-free)        | `@voltras/workout-analytics`                    | rep detection, VBT, e1RM, fatigue           |
| Live model + reducers          | `state/live-state.ts`, `state/event-bridge.ts`  | authoritative in-memory state               |
| Persistence adapter            | `store/sqlite-store.ts`                         | sessions/sets/reps                          |
| Read-models (query projectors) | `dashboard/read-models/` _(target — see below)_ | e1RM trend, capacity band, meso, PR, volume |
| HTTP/SSE adapter               | `dashboard/server.ts`                           | routing + serialization ONLY                |

The read-models are **pure functions over the store** and are unit-tested
without HTTP. `server.ts` stays a thin adapter: any domain math living inside it
is a smell to move down into `read-models/`.

> **Target refinement (highest-value first move).** `server.ts` currently mixes
> the HTTP adapter with the domain read-model logic (~1,140 lines including a
> Kalman filter and ~6 projections). Extracting those projections into pure,
> unit-tested `dashboard/read-models/*` modules is the single highest-value,
> lowest-risk step — it makes the domain queries testable without HTTP and
> leaves `server.ts` a thin routing/serialization adapter.

## 4. Client-side layers

```
/api/snapshot ─┐
               ├─▶ store (single model)  ──▶ adapter.ts (projector) ──▶ titan panels
/api/stream ───┘   reducer: {snapshot|sse-delta}          (buildCurrentSet, buildHeroSets, …)
```

- **Store (target):** one normalized model read via `useSyncExternalStore`
  (React 18 built-in, tearing-safe), updated by a single reducer handling
  `snapshot` (full replace) and `sse-delta` (patch). This makes snapshot↔delta
  reconciliation explicit and testable. Today this is ~15 `useState` hooks in
  `main.tsx`; consolidating them into one store + reducer is part of the land-it
  migration. (Redux/RTK is unnecessary; a single reducer suffices.)
- **Projector** (`adapter.ts`): the _one_ pure Snapshot→titan-props seam. All
  velocity/RPE math routes through `@voltras/workout-analytics` so every panel
  shows identical numbers. This already exists and is the layer to preserve.
- **Live overlay** (`live-stream.ts`): `useLiveStream` interpolates the phase
  stream via RAF and commits the live subtree at ~20 Hz. Scoped to live panels;
  structural data never lives only here.
- **Design system**: titan components are purely presentational and are fed
  view-models by the projector — they never fetch or hold domain state.

## 5. Security posture

`127.0.0.1` bind only, no CORS, no auth — the loopback bind is the privacy
boundary. Reaching the dashboard from another device would require an opt-in
host override **and** a bearer-token check added together.

## 6. Rationale for the cadences

- Snapshot poll: a slow reconcile (target 2–5 s), not a live loop. Live truth
  arrives on the SSE stream; the poll only hydrates and heals dropped deltas.
- SSE: native frame cadence with a ~20 Hz safety cap; phase flips are never
  throttled so the tempo bar snaps crisply.
- Historical read-models: 15 s + refetch-on-exercise-change (they're history,
  not live).

## 7. Do NOT (out of scope for the shipping dashboard)

WebSockets (the channel is unidirectional), client-owned BLE (Web Bluetooth
can't run the wall), a monorepo split, and a shared cross-app `session-core`
package are all **convergence** concerns — see
[`future-convergence-deep-dive.md`](./future-convergence-deep-dive.md). The
shipping dashboard needs none of them.
