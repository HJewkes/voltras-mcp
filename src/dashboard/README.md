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

## The write guard (VW-500)

The loopback bind stops a device on the LAN. It stops nothing in the browser:
until this guard landed, any page open in any browser on this machine could
POST to the write routes below, because a cross-origin write does not need to
read a response to have happened. Every non-GET request now passes the same
guard (`write-guard.ts`) BEFORE route matching, so a seventh write route cannot
be added unguarded.

| # | Route | Guards | Lease |
| --- | --- | --- | --- |
| 1 | `POST /api/plan/programs` | loopback Host, same `Origin`, JSON body, boot token | not needed — sqlite plan write, no device I/O |
| 2 | `POST /api/plan/programs/:id/workouts` | same | same |
| 3 | `POST /api/plan/templates/:id/exercises` | same | same |
| 4 | `POST /api/plan/templates/:id/reorder` | same | same |
| 5 | `PATCH /api/plan/exercises/:id` | same | same |
| 6 | `DELETE /api/plan/exercises/:id` | same | same |

None of the six touches the device, so none takes the single-writer lease. A
route that ever does must take it under the dashboard's own client id.

The four checks, in the order a refusal names them:

| Check | Refusal | Why |
| --- | --- | --- |
| `Host` is `127.0.0.1`, `localhost` or `[::1]`, port optional | 403 `foreign_host` | Origin-vs-Host alone is defeated by DNS rebinding: a hostile domain resolving to 127.0.0.1 makes the two agree |
| `Origin` present and equal to the request's own `Host` | 403 `origin_required` / `foreign_origin` | A page cannot forge `Origin`. Comparing against `Host` survives the ephemeral-port fallback and the `127.0.0.1`/`localhost` alias |
| `content-type` is `application/json` | 415 `unsupported_media_type` | A cross-site `<form>` post can only send the three CORS-simple types, so it can never reach a handler |
| `x-vmcp-dashboard-token` equals this boot's token | 403 `token_required` / `stale_token` | A custom header also forces a CORS preflight the sidecar never answers, so a cross-origin fetch dies before the request is sent |

**A missing `Origin` is refused.** Per the Fetch spec a browser always sends it
on a non-GET request, same-origin included, so requiring it costs the SPA
nothing and cleanly separates a browser from a non-browser caller. A script or
a non-browser client sets the header itself.

**How the SPA gets the token.** It is minted once per `startDashboardServer`
call (before the EADDRINUSE retry, so the fallback port keeps the same one) and
delivered two ways: substituted into the `vmcp-write-token` `<meta>` tag of the
served `index.html`, and readable at `GET /api/bootstrap`. Both responses are
`cache-control: no-store`. A cross-origin page can SEND that GET but cannot
read the reply — the sidecar sends no CORS headers — and the route also refuses
a request the browser labels cross-site via `Sec-Fetch-Site`.

**How it survives the wall.** Reads are not guarded, so the 2 s poll and the
auto-refresh are untouched. A tab left open across a server restart holds a dead
token; the shared `spa/api-client.ts` helper catches the `stale_token` refusal,
re-reads `/api/bootstrap` and retries once, so a stale wall tab heals on its
next write instead of needing a human to reload it.

**The capture and preview scripts need no token.** They are GET-only
(`scripts/lib/dashboard-launch.mjs`), and `npm run docs:captures` drives the
real page in a browser, which picks the token up from `index.html` like any
other client.

## The action layer (VW-502)

`POST /api/actions/:name` runs an allowlisted tool's own zod schema and its own
handler, so the dashboard and the MCP tools cannot disagree. The body is
`{ actionId, input, actor?, surface?, deviceId?, flowId?, flowStep? }`.

**An unknown or non-allowlisted name answers 403, never 404.** Probing the
layer reveals nothing about what exists. Every W3 (device) and W4 (coach or
voice only) tool is refused the same way.

**The handler is not the one a connection installs.** `applyLeaseGuard` replaces
every write tool's callback with one that acquires the DEVICE lease under the
connection's client id, and tools register per connection. Running that from the
wall would take the device lease for a bodyweight entry, under some terminal
session's identity, and would not exist at all with no client attached. So
`actions/capture-handlers.ts` captures the unguarded handlers once at boot,
bound to the shared state. `capture-handlers.test.ts` pins it: the captured
handler runs with another client holding the lease and does not answer
`LEASE_HELD`, where the connection's callback does.

### Who an action says it was

`POST /api/actions` **pins the actor to `user`** and refuses a body claiming
`coach` or `tick`. A request reaching that route came from a browser on this
machine — that is what the write guard establishes — so it is a human tap. The
coach and the agent-free tick do not arrive that way: they call `executeAudited`
in-process and stamp their own actor there. Without the pin, anyone holding the
write token could file a human tap as an agent decision and the column would
prove nothing.

The **surface** stays the client's to say, narrowed to `wall` or `phone`. Both
are the owner's own browser and the server cannot tell them apart, so refusing
the distinction would lose a fact and gain nothing.

### Which display sent it (VW-521)

`surface` is a KIND of surface, never a particular one: two walls in one house
both say `wall`. An optional **`deviceId`** names the display, so the trail can
say which one the lifter was standing at. Absent is valid and is the common
case; every row written before schema v39 reads none.

It is a **LABEL, exactly as `surface` is**. The server cannot check the name and
**nothing branches on it or on `surface` to decide what a request may do** —
otherwise a client would choose its own permissions by relabelling itself.
`actions/__tests__/execute.test.ts` pins that: a device tool is refused 403
under every surface and device id, and an allowlisted tool runs at the same tier
under every one of them.

The only thing refused is a string the audit trail could not usefully store:
letters, digits, `.`, `_`, `:` and `-`, starting with a letter or digit, up to
64 characters (`store/ui-action-device-id.ts`). `listUiActions({ deviceId })` is
the read that separates two walls.

### Idempotency

The client sends one `actionId` per SUBMIT, reused across retries.

| Case | Answer | Did the handler run? |
| --- | --- | --- |
| New id | the result | once |
| Same id, same input | the STORED result, `replayed: true` | no |
| Same id, different input | 409 `action_id_reused` | no |
| Same id, row still `pending` | 409 `indeterminate` | no |

The input hash is sha256 over a key-sorted rendering taken AFTER the tool's own
parse, so key order and absent-versus-undefined cannot split one submission
into two.

### Two steps, and the crash window

The claim and the completion are two statements, not one transaction. They
cannot be one: `declareDietPhase` and six other store methods open their own
transactions and the store has no SAVEPOINT nesting, so an outer `BEGIN` around
a handler fails outright.

Claiming FIRST is what makes this safe. The primary key refuses the second claim
before any handler runs, so two racing submits of one id cannot both execute.

The cost is one window: a crash between the handler's write and the completion
leaves the row `pending`, and whether the write landed is genuinely unknown. A
replay then answers `indeterminate`, and the SPA surfaces that as "re-read
state, do not resubmit". **Nothing sweeps pending rows at boot** — rewriting one
to `error` would assert an outcome nobody knows. `listUiActions({ status:
'pending' })` is the read for a later surface to show them.

### The six plan routes

They keep their URLs AND their response bodies — the plan payload, not the
action envelope, because the SPA reads it directly. They gain the audit row and
the actor stamp, under the names `plan.program.create`, `plan.workout.create`,
`plan.exercise.create`, `plan.exercise.reorder`, `plan.exercise.update` and
`plan.exercise.delete`. These are not tools, so they are not in the allowlist;
they run `plan-api.ts` as before.

A request with no `actionId` still works and is still audited, under a
server-minted id — but it buys NO retry safety, because a retry mints another
id and runs again. The SPA always sends its own.

**The boundary is the browser, not the OS account.** A hostile web page in a
local browser is in scope. Another process running as this user is not: it can
read the token from `/api/bootstrap`, or read the sqlite store directly, and no
header check changes that. A browser extension holding host permissions for this
origin sits on the same side of that line as a local process — its content
script can read the token straight out of the `<meta>` tag — and is a documented
non-goal rather than an oversight.

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
├── live-page/                     # the live page itself (LivePage, ExerciseHeader, RestView, ...)
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
