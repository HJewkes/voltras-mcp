# Future: Mobile ↔ MCP Convergence (deep dive)

Status: **FUTURE / NOT NOW.** This documents a deferred direction and its
blockers. Nothing here is scheduled; the shipping MCP dashboard
([`dashboard-data-layer.md`](./dashboard-data-layer.md)) does not depend on any
of it.

## 1. The vision

The mobile app and the MCP dashboard render the same fitness domain (sessions,
sets, VBT, e1RM, fatigue). Today they diverge in two ways that matter:

1. **Connection topology** — the dashboard is a _thin client_ (server owns
   BLE via node-sdk); the mobile app is a _thick client_ (React Native BLE owns
   the device on-device).
2. **Domain versions** — they consume the shared domain packages at
   incompatible majors (see §3).

Convergence means: **one framework-agnostic session core** (reducers +
selectors + view-models) consumed by both shells, with the connection topology
as a _pluggable port_ rather than a fork in the domain.

## 2. The thick/thin connection fork — keep it, behind a port

The fork is legitimate and should be preserved, not erased:

|              | MCP dashboard                                          | Mobile app                        |
| ------------ | ------------------------------------------------------ | --------------------------------- |
| Device owner | Node server (noble central)                            | RN BLE (on-device)                |
| UI role      | thin — renders snapshots                               | thick — owns connection + renders |
| Why          | Web Bluetooth can't run the wall (iOS/background gaps) | app must work standalone, offline |

Both should feed the _same_ session core through a `TelemetrySource` port
(`onFrame`/`onRep`/`onSet…`). One adapter wraps node-sdk; another wraps RN BLE.
The core — rep-boundary reducer, live-state, projector — never knows which.
This is textbook ports-and-adapters: technology-agnostic core, one adapter per
transport.

## 3. Blocker: the domain version gap

The single hard blocker to a shared core is that the two shells pin the domain
packages at incompatible majors:

| Package                      | MCP dashboard | Mobile app |
| ---------------------------- | ------------- | ---------- |
| `@voltras/workout-analytics` | ^1.5.0        | ^0.2.0     |
| `@voltras/node-sdk`          | ^0.11.0       | ^0.3.0     |

A shared `session-core` cannot be built until both shells sit on one compatible
`workout-analytics` line (rep detection, VBT, e1RM shapes have all moved across
those majors). **Reconciling this is prerequisite work** — everything below
assumes it is done. It's also worth noting independently of convergence: the two
apps may not compute reps identically today.

## 4. Sketch: a shared `session-core` package

A framework-free package (no React, no node, no RN, no SDK imports) holding
what `LiveState` + `adapter.ts` already are today:

```
packages/session-core/
  ports/            TelemetrySource, SessionStore   (interfaces only)
  model/            live-state reducer, rep-boundary state machine
  selectors/        currentSet, sessionProgress, connectionStatus
  view-models/      titan-shaped projections (shared by both shells)
  schema/           live-signal wire types (today: state/live-signal.ts)
```

- MCP shell: node-sdk adapter → session-core → HTTP/SSE → browser projector.
- Mobile shell: RN-BLE adapter → session-core → RN screens.
- Both import the _same_ selectors/view-models, so a metric is defined once.

The seed already exists: `state/live-signal.ts` is imported type-only by the
SPA today — that shared schema is the first file `session-core/schema` adopts.

## 5. Phased path (each phase independently shippable)

1. **Unblock**: converge `workout-analytics` / `node-sdk` to one line across
   both repos. (Prerequisite; nothing else starts until this lands.)
2. **Extract core in place**: pull the framework-free reducers/selectors/
   view-models out of `voltras-mcp` (`live-state`, `adapter.ts`) into a local
   `session-core` module, still single-repo. Prove the MCP dashboard runs on it.
3. **Define the `TelemetrySource` port**: refactor `event-bridge` to consume the
   port; node-sdk becomes one adapter behind it.
4. **Promote to a workspace package**: move `session-core` to a shared package;
   MCP consumes it as a dependency.
5. **Mobile adopts**: RN-BLE adapter implements the same port; mobile screens
   consume the shared selectors/view-models.

## 6. Notes on the current pieces this would build on

- **The mobile app is dormant** (not abandoned — it holds good code and ideas),
  and MCP is the current focus. Convergence is a "pull ideas across as we go"
  intent, not a scheduled migration.
- **titan** (`@titan-design/react-ui`) is already the shared presentational
  layer both shells render into — the rendering half of convergence is done.
- **R2 dashboard harness** (`feat/VMCP-r2-react-harness`) is a no-server fixture
  harness upstream of the data layer; when it graduates to live it should mount
  the single-store + `adapter.ts` projector rather than re-poll from scratch.

## 7. Explicitly out of scope for the dashboard-now work

WebSockets, client-owned BLE, the monorepo split, and the shared package are all
convergence concerns. The shipping dashboard needs none of them; it lands on the
architecture in [`dashboard-data-layer.md`](./dashboard-data-layer.md).
