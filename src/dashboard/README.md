# voltras-mcp dashboard

A read-only, loopback-only HTTP sidecar (`src/dashboard/server.ts`) that
exposes voltras-mcp's live session/device state to a local browser, and two
independent front ends that render it:

| Route      | Source                  | What it is                                                                                                         |
| ---------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /`    | `dashboard-html.ts`     | Legacy zero-build vanilla-HTML dashboard. Inline `<script>`, no build step, no framework. Still the default route. |
| `GET /app` | `spa/` (this directory) | The titan-design React SPA — Vite + `react-native-web`, built ahead of time into `dist/spa`.                       |

Both routes are served by the same `node:http` server and read the same
`/api/snapshot` endpoint; neither depends on or supersedes the other. See the
module header of `server.ts` for the full route table and the loopback-only
security rationale.

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
├── main.tsx              # entry point: polls /api/snapshot, renders <App>
├── adapter.ts             # snapshot JSON -> panel view-model (pure functions)
├── bodymap.ts              # active exercise -> BodyMap muscle-intensity data
├── colors.ts               # single source of truth for every color the SPA uses
├── panels/                 # one file per panel, each wrapping a PanelCard
├── vite.config.ts           # build config (aliases + Tailwind wiring, below)
├── vite-rn-svg-plugins.ts    # react-native-svg / body-highlighter web resolution
├── tailwind.config.cjs        # scans titan's dist for the classes it emits
├── postcss.config.cjs          # Tailwind + autoprefixer pipeline
└── index.html                   # Vite HTML entry, mounts #root
```

`main.tsx` polls `/api/snapshot` every 500 ms (a separate 1 s tick drives the
rest-timer count-up and a staleness watchdog independent of the poll). Each
poll's JSON is folded through `adapter.ts`'s pure `buildXxx`/`reduceSnapshot`
functions into per-panel view-models — no component reaches into the raw
snapshot directly. Completed-set accumulation (the set-log table and session
totals) is derived client-side: a set is logged when `sets.active` transitions
non-null → null across two polls.

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

### The build pipeline: two Vite aliases + Tailwind PostCSS + one esbuild pass

titan-design publishes its `dist` (not source) as React Native components, and
three of its transitive dependencies need help to run in a browser bundler.
This is the reusable part — the same shape of problem will recur for any
other RN-on-web consumer of titan-design:

1. **`react-native` → `react-native-web`** (Vite `resolve.alias`). titan's
   compiled `dist` imports the bare `react-native` specifier; nothing on npm
   provides that package for a browser build, so it's aliased straight to
   `react-native-web`.
2. **`react-native-svg` → its ESM (`"module"`) build**, with `.web.js`
   siblings resolved ahead of their native Flow counterparts
   (`reactNativeSvgWebResolver()` in `vite-rn-svg-plugins.ts`). `react-native-svg`
   ships web implementations as `.web.js` siblings of native (Flow) Fabric
   sources; a plain Node/Rollup resolver ignores the `.web.js` naming
   convention and loads the native file instead, which fails to parse
   (`Unexpected token 'typeof'`).
3. **`react-native-body-highlighter` esbuild-bundled to self-contained ESM**
   (`reactNativeBodyHighlighterEsm()`). That package ships untranspiled-JSX
   CommonJS with no static ESM `default` Rollup can import; the plugin
   pre-bundles it with esbuild (JSX via the automatic runtime, `react-native-svg`'s
   web build inlined, `react`/`react-native` kept external so the app's single
   React copy is shared — a duplicate copy trips "invalid hook call" on
   `useCallback`).

`vite-rn-svg-plugins.ts` is a trimmed, npm-adapted port of titan-design's own
`packages/ui/vite-rn-svg-plugins.ts` (the resolution titan's `build-storybook`
already proves in production). Only the production/Rollup half is needed here
— the SPA is exclusively built ahead of time via `vite build`, never served
through Vite's dev server, so titan's dev-only esbuild-optimizer variant is
intentionally omitted.

Separately, **Tailwind runs over titan's `dist`, not over `spa/`.** titan's
compiled components emit Tailwind utility class strings (e.g.
`text-text-primary`) with no inline colors; those classes only render legible
text if a Tailwind build actually generates the matching CSS. `postcss.config.cjs`
runs Tailwind (configured in `tailwind.config.cjs`, which points `content` at
titan's `dist` so it discovers those classes) plus autoprefixer. Skip this
pipeline and every titan component in the dashboard renders correctly laid
out but colorless. The generated Tailwind classes resolve to CSS variables
from `@titan-design/react-ui/theme/global.css` (imported once in `main.tsx`),
whose `:root` is dark by default — see `colors.ts` for the full color policy
(titan's semantic `--color-*` tokens are the _only_ color source anywhere
under `spa/`).

## Accessibility

- The connection-status chip, disconnect banner, and battery indicator are all
  `role="status"` / `role="alert"` with `aria-live`, and none of them is a
  color-only signal — each carries a text label alongside its color (e.g. the
  status dot's tone always has an adjacent text label; `battery.low` always
  renders a percentage, not just a red tint).
- Every panel (`PanelCard`) is wrapped in a native `<section role="region"
aria-label="...">` named after its visible title, so screen-reader users can
  jump directly to "Current set", "Rest timer", "Sets this session", "Session
  progress", or "Muscle heatmap" instead of reading the grid linearly.
- The set-log table is wrapped in an `aria-live="polite"` region — the row
  count only grows when a set completes (never mid-set), so it announces once
  per finished set without chattering during live reps.
- The BodyMap front/back toggle and muscle legend come from titan-design's
  `BodyMap` component, which already renders them as real, keyboard-operable
  `Pressable`s (`accessibilityRole="button"`, `accessibilityLabel`,
  `aria-pressed`) with the muscle SVG itself marked `aria-hidden` — the
  legend buttons are the accessible interface to the heatmap, not the SVG.

## Building and viewing

```bash
npm run build:dashboard   # vite build --config src/dashboard/spa/vite.config.ts
                           # emits dist/spa (base: /app/)
npm run build              # tsc — builds the server itself
npm start                    # node ./dist/bin.js — starts voltras-mcp,
                              # which starts the dashboard sidecar
```

Then, with the MCP server running, open:

- `http://127.0.0.1:7723/` — legacy vanilla-HTML dashboard
- `http://127.0.0.1:7723/app` — the titan-design SPA (this directory)

(Port defaults to `7723`; configurable via `VMCP_DASHBOARD_PORT`.) If
`dist/spa` hasn't been built yet, `/app` serves a small "SPA not built" HTML
placeholder rather than a 404 or a server error.

`npm run typecheck:spa` (part of `npm run typecheck`) type-checks `spa/`
against its own `tsconfig.json` — deliberately separate from the server's
`tsconfig.json` since the SPA targets `DOM`/`ES2022` for the browser, not
Node.
