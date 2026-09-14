# voltras-mcp dashboard

A loopback-only HTTP sidecar (`src/dashboard/server.ts`) that exposes
voltras-mcp's live session/device state to a local browser, and the front end
that renders it: `GET /app`, the titan-design React SPA (Vite +
`react-native-web`, built ahead of time into `dist/spa`). See the module header
of `server.ts` for the full route table and the loopback-only security
rationale.

## Pages

The SPA hash-routes (`spa/routing.ts`) — hash, not history, because the sidecar
serves one static `index.html` with no SPA fallback:

| URL                | Page                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `/app` or `/app#/` | `LivePagePanel` — the north-star live page. The wall display; deliberately chrome-free.                      |
| `/app#/plan`       | Plan builder (VW-120): browse the exercise catalog, see the workout being planned, edit it by hand.          |
| `/app#/summary`    | Session-completion screen (VW-120) for the most recent session. `#/summary/<sessionId>` pins a specific one. |

The plan builder re-polls `/api/plan-tree` every 2 s, so lifts an agent adds over
MCP (`plan.exercise.create`) show up without a reload. It is NOT on the SSE
stream: that channel carries derived live telemetry signals (phase / rep / set)
and a plan write emits none — see `spa/planner/planner-client.ts`.

Writes go through a small REST surface (`POST /api/plan/programs`,
`POST /api/plan/templates/:id/exercises`, `PATCH /api/plan/exercises/:id`, …)
that `dashboard/plan-api.ts` implements as a second thin adapter over the SAME
`SessionStore` methods the `plan.*` MCP tools call — not a reimplementation. The
one piece of real logic on the completion screen, the progression heuristic, is
imported directly (`computeProgressionDelta` from `tools/plan-tools.ts`), so the
dashboard and `plan.suggest_progression` can never disagree. There is
deliberately no delete route: `SessionStore` has no planning delete.

## Why a React Native component library on the web

The dashboard consumes `@titan-design/react-ui`, Voltra's shared component
library, so the panels look and behave like the rest of the product instead of
being a one-off reimplementation. titan-design is authored as React Native
components (`View`, `Text`, `Pressable`, ...) so it can also ship to the
mobile app; `react-native-web` is what lets those same compiled components
render as ordinary DOM on the web, no native runtime involved.

## SPA architecture

```
spa/
├── main.tsx              # entry point: I/O (poll/tick/SSE) + the hash-route switch
├── routing.ts             # parseRoute/routeHash — the page table (pure)
├── adapter.ts               # snapshot JSON -> shared view-model helpers (pure functions)
├── store.ts                   # zustand store: snapshot/historical/live/planner slices
├── live-stream.ts               # /api/stream SSE subscription
├── live-page/                     # the live page itself (LivePage, LiveView, RestView, ...)
├── panels/                          # LivePagePanel + its view-model mappers (fatigue-view.ts, live-view.ts)
├── planner/                           # plan builder + session-completion pages, their client and mappers
├── vite.config.ts                       # build config (react-native-web alias + Tailwind wiring)
├── tailwind.config.cjs               # scans titan's dist for the classes it emits
├── postcss.config.cjs                  # Tailwind + autoprefixer pipeline
└── index.html                            # Vite HTML entry, mounts #root
```

`main.tsx` polls `/api/snapshot` every 2 s as a reconciliation backstop (a
separate 1 s tick drives the rest-timer count-up and a staleness watchdog); the
`/api/stream` SSE overlay carries the ~20 Hz live data and instant structural
pushes. Each poll's JSON is folded through `adapter.ts`'s pure
`buildXxx`/`reduceSnapshot` functions and `store.ts`'s actions into the
`LivePagePanel` render model — no component reaches into the raw snapshot
directly. Completed-set accumulation (used by the ROM/PREV columns) is derived
client-side: a set is logged when `sets.active` transitions non-null → null
across two polls.

### The `/api/snapshot` contract

```ts
{
  session: ActiveSession | null;
  devices: Array<{ slotId: string; device: DeviceSnapshot }>;
  sets: { active: ActiveSet | null };
  activeExercise: { primaryMuscles: string[]; secondaryMuscles: string[] } | null;
}
```

**Confidentiality boundary: this is JSON only.** No protocol bytes, frames, or command
codes ever cross into the dashboard — the snapshot is built from already-typed
session/device/exercise state (`src/state/live-state.ts`), not from anything
on the wire. If you're adding a field to the snapshot, it must already be a
plain, human-meaningful value (a weight, a mode string, a muscle name); if you
find yourself reaching for a raw command code or frame byte to answer a
dashboard need, that's a signal the field belongs somewhere else.

### The `/api/muscle-strength` contract (VW-330)

```ts
{
  muscleMapVersion: string; // exercises/muscle-map.ts MUSCLE_MAP_VERSION
  muscles: Array<{
    muscle: TitanMuscleGroup; // all 15 slugs, always
    exercises: Array<{
      exerciseId: string;
      name: string;
      side: 'left' | 'right' | null; // null = the sets recorded no side
      bestE1rm: { value: number; band: E1RMBand; method: E1RMMethod; confidence: number } | null;
      slopePctPerWeek: number | null; // fitted weekly change, % of the fit's day-0 value
      rSquared: number | null;
      isPR: boolean;
      priorBest: number | null;
      plateau: 'plateau' | 'tolerated' | 'none' | null;
    }>;
    agreement: 'stronger' | 'weaker' | 'mixed' | 'insufficient';
    earlyPhase: boolean;
  }>;
  agreementBasis: string;
  earlyPhaseBasis: string;
}
```

A 12-week window, scoped by `read-models/muscle-set-scope.ts` — the one copy
`muscle-plan` and `muscle-week` also read, so the three panels of one body-map
figure cannot disagree about what a working set is or which muscle it counts
toward. The slope, `rSquared` and `plateau` come from `metrics.compute
history.trend` (metric `e1rm`) run once per (exercise, side) — the same
function, not a second implementation. `bestE1rm`, `isPR` and `priorBest` come
from the Epley estimate and the shared `evaluateE1RMPr`, the same PR verdict the
summary page's hero card shows.

**A bilateral exercise yields one row per side and never a merged one.** Pooling
two limbs into one strength number hides exactly the finding a per-side read
exists to surface (`src/analytics/side-comparison.ts`). `agreement` needs two
separate exercises trending the same way before it names a direction, and it is
an agreement of signs, not a magnitude verdict: no citable flat threshold exists
for a load trend (VW-230) and none is invented here.

### The build pipeline: one Vite alias + Tailwind PostCSS

titan-design publishes its `dist` (not source) as React Native components.
Its compiled `dist` imports the bare `react-native` specifier, which nothing
on npm provides for a browser build, so `vite.config.ts` aliases it straight
to `react-native-web` (`resolve.alias`). `vite-rn-svg-plugins.ts` holds the
`.web.*`-first extension order that resolution depends on.

Separately, **Tailwind runs over titan's `dist`, not over `spa/`.** titan's
compiled components emit Tailwind utility class strings (e.g.
`text-text-primary`) with no inline colors; those classes only render legible
text if a Tailwind build actually generates the matching CSS. `postcss.config.cjs`
runs Tailwind (configured in `tailwind.config.cjs`, which points `content` at
titan's `dist` so it discovers those classes) plus autoprefixer. Skip this
pipeline and every titan component in the dashboard renders correctly laid
out but colorless. The generated Tailwind classes resolve to CSS variables
from `@titan-design/react-ui/theme/global.css` (imported once in `main.tsx`),
whose `:root` is dark by default — titan's semantic `--color-*` tokens are the
_only_ color source anywhere under `spa/`.

## Building and viewing

```bash
npm run build:dashboard   # vite build --config src/dashboard/spa/vite.config.ts
                           # emits dist/spa (base: /app/)
npm run build              # tsc — builds the server itself
npm start                    # node ./dist/bin.js — starts voltras-mcp,
                              # which starts the dashboard sidecar
```

Then, with the MCP server running, open `http://127.0.0.1:7723/app` — the sole
dashboard surface; `/` redirects there. (Port defaults to `7723`; configurable
via `VMCP_DASHBOARD_PORT`, and a port already held by another session's server
falls back to an OS-assigned one, so `server.health`'s `dashboardUrl` is the
authoritative address.) If `dist/spa` hasn't been built yet, `/app` serves a
small "SPA not built" HTML placeholder rather than a 404 or a server error.

An optional `?variant=live` / `?variant=live-dual` query param pins the single
or diverging stage for testing; without it, `LivePagePanel` picks the stage
from live state — which limb slots are bound off the snapshot (VMCP-04.07).

`npm run typecheck:spa` (part of `npm run typecheck`) type-checks `spa/`
against its own `tsconfig.json` — deliberately separate from the server's
`tsconfig.json` since the SPA targets `DOM`/`ES2022` for the browser, not
Node.
