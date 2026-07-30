# voltras-mcp dashboard

A read-only, loopback-only HTTP sidecar (`src/dashboard/server.ts`) that
exposes voltras-mcp's live session/device state to a local browser, and the
one front end that renders it: `GET /app`, the titan-design React SPA (Vite +
`react-native-web`, built ahead of time into `dist/spa`). It always renders
`LivePagePanel` — the north-star live page; there is no other mode or route.
See the module header of `server.ts` for the full route table and the
loopback-only security rationale.

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
├── main.tsx              # entry point: I/O (poll/tick/SSE), renders <LivePagePanel>
├── adapter.ts             # snapshot JSON -> shared view-model helpers (pure functions)
├── store.ts                 # zustand store: snapshot/historical/live slices
├── live-stream.ts             # /api/stream SSE subscription
├── live-page/                  # the live page itself (LivePage, LiveView, RestView, ...)
├── panels/                       # LivePagePanel + its view-model mappers (fatigue-view.ts, live-view.ts)
├── vite.config.ts                  # build config (react-native-web alias + Tailwind wiring)
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
dashboard surface. (Port defaults to `7723`; configurable via
`VMCP_DASHBOARD_PORT`.) If `dist/spa` hasn't been built yet, `/app` serves a
small "SPA not built" HTML placeholder rather than a 404 or a server error.

An optional `?variant=live` / `?variant=live-dual` query param pins the single
or diverging stage for testing; without it, `LivePagePanel` picks the stage
from live state — which limb slots are bound off the snapshot (VMCP-04.07).

`npm run typecheck:spa` (part of `npm run typecheck`) type-checks `spa/`
against its own `tsconfig.json` — deliberately separate from the server's
`tsconfig.json` since the SPA targets `DOM`/`ES2022` for the browser, not
Node.
