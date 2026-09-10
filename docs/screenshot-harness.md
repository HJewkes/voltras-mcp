# The headless screenshot harness (w4-07)

`npm run docs:captures` produces every screenshot the docs site publishes, from a
committed definition, with no hardware and no browser interaction.

| Piece                                 | What it is                                                           |
| ------------------------------------- | -------------------------------------------------------------------- |
| `src/docs/capture-shots.ts`           | The definition: shots, routes, viewport, wait predicates, assertions |
| `scripts/lib/mock-burst.mjs`          | The determinism lever: exact rep bursts from a parked mock device    |
| `scripts/capture-screens.mjs`         | The harness: boots a scenario, waits, screenshots, asserts, writes   |
| `site/public/captures/*.png`          | The output, served by VitePress at `/captures/…`                     |
| `site/public/captures/manifest.json`  | What was captured, and from which definition                         |
| `src/__tests__/docs/captures.test.ts` | The staleness gate, run by `npm test` in CI                          |

## Running it

```bash
npm run build && npm run build:dashboard   # the harness refuses to run without both
npm run docs:captures                      # every shot, ~4 minutes
npm run docs:captures -- --only live-rest  # re-take one, keeping the rest of the manifest
```

## Installing the browser

`playwright-core` is the dependency, deliberately — it has **no `postinstall`**, so
`npm ci` downloads nothing and CI is untouched. The browser is a one-time manual step:

```bash
npx playwright@1.63.0 install chromium
```

Version 1.63.0 is the release whose bundled chromium revision (1243) matches the pinned
`playwright-core`. If `~/Library/Caches/ms-playwright/chromium-1243` already exists the
command is a no-op; on this machine it already did, so the harness cost nothing to set up.
The install is **not** wired into `postinstall` and **not** run in CI: CI never takes a
screenshot, and a browser download on every install is hostile.

## What each shot is, and where it comes from

Every shot runs the real MCP pipeline against `VOLTRA_ADAPTER=mock` — real tools, real
event bridge, real `LiveState`, real `set.end`. Nothing is stubbed at the HTTP layer.

| Shot                | Scenario                                      | Shows                            |
| ------------------- | --------------------------------------------- | -------------------------------- |
| `dashboard-cold`    | bare `dist/bin.js`, nothing connected         | the empty wall view              |
| `live-mid-set`      | `dashboard-plan-drive.mjs`                    | live page mid-set with a plan    |
| `live-rest`         | `dashboard-plan-drive.mjs`                    | the rest stage between two sets  |
| `session-summary`   | `dashboard-plan-drive.mjs`                    | the completion screen            |
| `plan-builder`      | `dashboard-plan-drive.mjs`                    | the plan builder with a template |
| `live-dual-mid-set` | `dashboard-mock-drive.mjs --dual`, asymmetric | the diverging two-slot stage     |

`dashboard-plan-drive.mjs` is the only driver that can show a prescription; `dashboard-sim`
carries no plan data and plain `dashboard-mock-drive` attaches none
([dashboard-drivers.md](dashboard-drivers.md)).

## Why every wait is a predicate

Each shot polls `/api/snapshot` — the same JSON the SPA polls — until the state it wants
is true. A fixed sleep writes a blank PNG on a slow machine, and **a blank dashboard
renders without throwing**, so nothing downstream would notice. After the predicate fires
the harness also waits for the shot's expected strings to be in the DOM, screenshots, then
re-reads the DOM and fails if any of them has gone.

The one non-predicate wait is `document.fonts.ready` plus two animation frames, which are
browser signals rather than a duration.

## Why the VALUES on the page are predictable (VW-215)

`MockBLEAdapter` free-runs: it streams a rep cycle continuously from `device.connect`, so
a driver that opens a set, sleeps and closes it cuts that stream at two arbitrary points.
The rep count drifts, the first rep is a partial, and every derived number moves with it.
Two runs of the first version of this harness disagreed on the live fatigue readout — 5.5
"Good" against 6.0 "Slowing" — and both were green.

The fix is in the drivers, not the harness: `--pinned-reps=N` (plan driver) and `--pinned`
(dual driver) park the mock device between sets and release it for **exactly N reps** per
set. The adapter's own set boundary is the one place its generator stops cleanly, and while
it rests it does not advance its phase state, so every burst emits an identical frame
sequence. The device is also parked *while the screenshot is taken*, so a shot is no longer
racing a driver.

Nothing is faked. The real SDK, event bridge, `LiveState`, analytics and SPA all still run
on real mock frames — what is pinned is when the device moves, not what the dashboard is
told. A canned `/api/snapshot` would prove only that the SPA can render a fixture.

Still not deterministic, and therefore never asserted: the wall clock, the rest countdown,
session start/end stamps, `DURATION`, and anything else derived from frame timestamps (a
frame is stamped with `Date.now()` at decode). The `expectValues` comment in the definition
lists them.

## What the staleness gate can and cannot check

**It cannot compare pixels.** Font hinting, GPU rasterisation and Skia antialiasing differ
between machines, and even on one machine two runs differ: the dashboard paints a wall
clock, a count-up rest timer, and session ids and timestamps that change every run. A byte
comparison would fail on every run; a perceptual threshold loose enough to survive that
would be loose enough never to fail. Neither is shipped.

**It checks everything around the pixels**, and each of these does fail:

- The manifest's `definitionHash` must equal the hash of the checked-in definition. Edit a
  shot's route, caption, predicate or assertions without re-running the harness and `npm test`
  goes red.
- The manifest must hold exactly the declared shots, in declaration order.
- Every declared shot must be on disk as a PNG at exactly `viewport x deviceScaleFactor`,
  above a byte floor that an empty render cannot clear.
- Each entry must record the same route, scenario, predicate, asserted labels **and
  asserted values** the definition declares — a capture taken against weaker assertions
  counts as stale.
- Every shot must pin at least one computed value.
- The captures directory must hold nothing the definition does not declare.
- Every `/captures/*.png` any site page references must resolve to a declared shot.

**The values are checked by the capture run, not by CI.** CI has no browser, so it can only
hold the committed capture to the values the definition pins *now*; the comparison against
a live page happens in `npm run docs:captures`, which fails and names the field:

```
[capture] FAIL: planned: live-mid-set: page never rendered
  "VL 20% VL 30% 0.50 0.49 0.47 0.46" but page has
  "VL 20% VL 30% 0.55 0.54 0.52 0.51 0.48 FATIGUE 5.…"
```

That is a real run, with one computation (`velocitiesMps` in `spa/adapter.ts`) scaled by
1.1 and nothing else touched. Every label assertion still passed — which is the point.

What that leaves uncovered, stated plainly: a value nobody pinned can still change, and
layout is not checked at all. A shot is only as honest as the strings it insists on seeing.

## Isolation

Each scenario gets its own SQLite store under a `mkdtemp` directory that is deleted on
exit, and its own OS-probed free dashboard port. `~/.voltras/vmcp.sqlite` is never opened:
these images are published, and it holds real training history.

`VMCP_DASHBOARD_PORT=0` is **not** a way to ask for an ephemeral port here.
`resolveDashboardPort` (`src/server.ts`) reads `0` as `off`, so the dashboard never binds
at all. The harness probes a free port with `net.createServer().listen(0)` and hands the
resulting number to the driver.

## Confidentiality

The captures are published to a public site. The mock adapter's synthetic data is the only
data in them: the device labels are `MOCK-VOLTRA-LEFT` / `MOCK-VOLTRA-RIGHT`, the plan is
the seeded `Mock Hypertrophy` program, and `/api/snapshot` carries typed session and
device state, never protocol bytes ([src/dashboard/README.md](../src/dashboard/README.md)).
The test runs the reference generator's own protocol guard over every shot name, caption,
route and asserted string. If the dashboard ever renders something of that shape, report it
rather than cropping around it.
