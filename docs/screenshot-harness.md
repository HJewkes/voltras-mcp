# The headless capture harness (w4-07, w5-08)

`npm run docs:captures` produces every screenshot **and every narrated screen recording**
the docs site publishes, from committed definitions, with no hardware and no browser
interaction.

| Piece                                 | What it is                                                             |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `src/docs/capture-shots.ts`           | The stills definition: shots, routes, viewport, predicates, assertions |
| `src/docs/capture-clips.ts`           | The clips definition: clips, scenarios, video constants, narration     |
| `scripts/lib/mock-burst.mjs`          | The determinism lever: exact rep bursts from a parked mock device      |
| `scripts/lib/dashboard-launch.mjs`    | Booting one scenario: free port, scratch store, bind wait, stop        |
| `scripts/capture-screens.mjs`         | The harness: boots a scenario, waits, captures, asserts, writes        |
| `site/guides/*.narration.txt`         | The spoken scripts, beside the guides that embed the clips             |
| `site/public/captures/*.png`          | The stills, served by VitePress at `/captures/…`                       |
| `site/public/captures/clips/*.mp4`    | The clips, and their narration tracks as separate `*.narration.m4a`    |
| `site/public/captures/manifest.json`  | What was captured, and from which definitions — one manifest, not two  |
| `src/__tests__/docs/captures.test.ts` | The stills staleness gate, run by `npm test` in CI                     |
| `src/__tests__/docs/clips.test.ts`    | The clips staleness gate, same job, same CI run                        |

## Running it

```bash
npm run build && npm run build:dashboard         # the harness refuses to run without both
npm run docs:captures                            # every shot and every clip, ~6 minutes
npm run docs:captures -- --only live-rest        # re-take one shot
npm run docs:captures -- --record planned-set    # re-take one clip
```

Either flag on its own narrows to that one thing, so re-taking one clip never costs a
four-minute screenshot run. Whatever a narrowed run does not re-take keeps its existing
manifest entry.

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

## Running it on a busy machine

A full run holds a browser, a driver process and an encoder open for minutes, so a machine
already under heavy load will intermittently reject a `fetch` to the sidecar outright. One
of those used to end the whole run several scenarios in, with a bare `fetch failed`. Reads
of `/api/snapshot` now retry a **connection-level** failure `TRANSIENT_FETCH_RETRIES`
times; an HTTP status is never retried, because a 500 is a real answer from a server that
is up. The predicate's own timeout is unchanged, so a sidecar that has genuinely gone away
still fails on schedule. If a run fails anyway, check the load average before the code.

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
| `goals`             | `dashboard-mock-drive.mjs --goal`, PR loop    | the goal-coach page with a PR    |

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
sequence. The device is also parked _while the screenshot is taken_, so a shot is no longer
racing a driver.

Nothing is faked. The real SDK, event bridge, `LiveState`, analytics and SPA all still run
on real mock frames — what is pinned is when the device moves, not what the dashboard is
told. A canned `/api/snapshot` would prove only that the SPA can render a fixture.

Still not deterministic, and therefore never asserted: the wall clock, the rest countdown,
session start/end stamps, `DURATION`, and anything else derived from frame timestamps (a
frame is stamped with `Date.now()` at decode). The `expectValues` comment in the definition
lists them. VW-389 made two of those — the wall clock and CSS/JS-animation settle — no
longer matter to the PNG's bytes either (see "Byte-reproducibility" below); the rest are
genuinely on the page and stay excluded from `expectValues` for the reason above.

## Byte-reproducibility on one machine (VW-389)

Two runs of `npm run docs:captures` on identical code, same machine, used to disagree on
every PNG. `scripts/capture-screens.mjs` now removes the two causes that were ours to
remove:

- **The wall clock.** `installShotDeterminism` calls `page.clock.setFixedTime(...)` before
  any navigation, pinning `Date.now()`/`new Date()` for every shot's page while leaving
  real timers (the 2s poll, the SSE stream) running. `emulateMedia({ reducedMotion: 'reduce' })`
  plus an injected stylesheet forcing every CSS animation/transition's duration to `0s` remove
  the second cause: a screenshot landing mid-transition.
- **JS-driven animation.** titan-design's charts animate through `requestAnimationFrame`
  directly, which no stylesheet reaches. `waitForVisualStability` screenshots on a loop until
  three consecutive samples come back byte-identical, so the shot only writes once the pixels
  have actually stopped moving, whatever is moving them.

That reaches every shot whose non-determinism was ours (the harness's) to fix. It does
**not** reach a shot whose page renders a value the SERVER computed from ITS OWN real clock:

| Shot                | Server-real-time field                                         | Byte-reproducible? |
| ------------------- | -------------------------------------------------------------- | ------------------ |
| `dashboard-cold`    | none                                                           | yes                |
| `plan-builder`      | none                                                           | yes                |
| `goals`             | none (the trajectory chart's x-axis is meso WEEKS, not time)   | yes                |
| `body-week`         | none (a seeded historical week, not the live wall clock)       | yes                |
| `live-mid-set`      | rep-shape curve `tMs` — real per-sample frame-decode time      | not guaranteed     |
| `live-dual-mid-set` | same, both slots' curves                                       | not guaranteed     |
| `live-rest`         | pace footer `ETA` — `resolveSessionPace`'s `nowMs: Date.now()` | not guaranteed     |
| `session-summary`   | session start/end stamps in the header                         | not guaranteed     |

"Not guaranteed" means exactly that and no more: the four rows above render a value the
SERVER computed from its own real clock, so nothing on the harness side pins it, and whether
two runs land on the same value is down to timing, not design. A fast back-to-back run can
have the frame-decode clock, the pace ETA or the session start/end stamp land on the same
value both times and come out byte-identical; a slower run, or one that straddles a clock
tick the faster run did not, comes out different. Neither outcome says anything about
correctness — both runs still have to satisfy every `expectValues` assertion.

Two two-run comparisons, `shasum -a 256` of each pair of PNGs (full digests are not
reproduced here — this page is published, and a 256-bit hex string is indistinguishable by
shape from a protocol value; they are on the PR that shipped this section instead), taken on
two different machines:

| PNG                     | Run A                      | Run B                     |
| ----------------------- | -------------------------- | ------------------------- |
| `dashboard-cold.png`    | identical                  | identical                 |
| `plan-builder.png`      | identical                  | identical                 |
| `goals.png`             | identical                  | identical                 |
| `body-week.png`         | identical                  | identical                 |
| `live-mid-set.png`      | differs — rep-shape curve  | differs — rep-shape curve |
| `live-rest.png`         | differs — pace ETA         | differs — pace ETA        |
| `live-dual-mid-set.png` | differs — rep-shape curve  | identical                 |
| `session-summary.png`   | differs — start/end stamps | identical                 |

The four rows above the "not guaranteed" line hold on every run seen so far, because nothing
on the page they render is time-derived. Below that line, a diff isn't guaranteed on any given
run — Run B's `live-dual-mid-set` and `session-summary` happened to land on the same
frame-decode time and the same session stamps both times — but when a diff DOES appear it
isolates to exactly the field named, confirmed by cropping the diff bounding box
(`ImageChops.difference`) — e.g. Run A's `live-rest` pair differs only inside an 8×12px region
that reads `8:49 PM` in one and `8:55 PM` in the other, the rendered `ETA` tile. Fixing this at
the pixel level would mean injecting a fake clock into the server process itself (frame-decode
timestamps, session `startedAt`/`endedAt`, `resolveSessionPace`'s `Date.now()` call) — a change
to production session/analytics timing code, not to the capture harness, and outside VW-389's
scope.

**The mutation proof**, showing the clock-freeze measure specifically is load-bearing:
commenting out the `page.clock.setFixedTime(...)` call in `installShotDeterminism` and
rerunning `dashboard-cold` renders the header clock at the real time (`21:15`, that run)
instead of the fixed `12:00` every frozen run shows, and its `shasum -a 256` no longer
matches the frozen baseline above. Restoring the call brings both the `12:00` clock and
the matching digest straight back.

`guardLocalOverwrite` in the harness refuses to overwrite a committed PNG with a byte-different
one unless `CAPTURES_ALLOW_LOCAL=1` is set, so the four not-guaranteed-reproducible shots can't
drift by accident on a routine local run — regenerating one is still a normal, deliberate
action, just an explicit one.

## What the staleness gate can and cannot check

**It cannot compare pixels ACROSS MACHINES.** Font hinting, GPU rasterisation and Skia
antialiasing differ between machines regardless of anything above, and four of the eight shots
carry a genuine server-real-time field even on one machine (see above). A byte comparison run
in CI would fail on every run there; a perceptual threshold loose enough to survive that would
be loose enough never to fail. Neither is shipped.

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
hold the committed capture to the values the definition pins _now_; the comparison against
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

## The narrated recordings (w5-08)

Two clips, deliberately, not a library: `planned-set` (a working set on the live page with
a prescription attached, embedded on the [planned-session guide](../site/guides/planned-session.md))
and `dual-divergence` (two slots diverging through a set and falling through to rest, on
the [bilateral guide](../site/guides/bilateral.md)).

A clip is built exactly like a shot — same drivers, same `/api/snapshot` predicates, same
page-text assertions — with the brackets moved. A shot waits for one state and asserts
against one moment. A clip opens the page when a **start** predicate holds, keeps sampling
the page text until an **end** predicate holds, records for a lead-out, and then asserts
that every expected string appeared at some point while the camera was running. The page is
never opened before the start predicate: recording begins the moment the page does, and a
clip whose page opened early opens on a blank stage, which encodes and plays back without
error.

### The narration, and why it is synthetic

Each clip's script is a plain text file beside the guide it belongs to. That file is the
**source** of the audio, never a transcript of it: edit it, re-run the harness, and the
voice changes. A human take would sound better and could not be re-rendered when the flow
changes, which is the same argument that made the capability reference generated rather
than typed. Both guides say so on the page.

Synthesis is a **documented local prerequisite**, not a dependency — nothing was added to
`package.json`. It needs a python with `kokoro-onnx` and `soundfile` installed, named by
`VMCP_NARRATION_PYTHON`:

```bash
VMCP_NARRATION_PYTHON=~/projects/demo-video-tooling/.venv-tts/bin/python npm run docs:captures
```

Without that variable the harness reuses the committed `*.narration.m4a` — but only if its
recorded hash still matches the script, so editing a script without the prerequisite is a
loud failure rather than a clip that quietly keeps saying the old thing. Kokoro is
byte-deterministic for a fixed voice and text: three separate runs of the same script
produced identical audio, so the narration half of a clip is reproducible in the strict
sense the video half is not.

The mux stream-copies that track, so what plays inside the MP4 is byte-identical to the
committed `.m4a`. It is also deliberately **shorter** than the video and is never padded —
an MP4 whose audio ends early is ordinary, and padding would turn an overrun script into a
word cut off mid-sentence instead of the hard error `NARRATION_HEADROOM_MS` makes it.

### Reusable segments

`ffmpeg` and `ffprobe` come from `/opt/homebrew/bin`, not from Playwright's bundled copy.
Everything a later composition needs is in `site/public/captures/clips/`, and the silent
video is one lossless stream copy away — no re-encode, no re-run of the harness:

```bash
ffmpeg -i planned-set.mp4 -an -c:v copy planned-set.silent.mp4   # video only
# the narration is already its own file: planned-set.narration.m4a
```

### What was measured, not asserted

Six independent renders of each clip on one machine, spanning three rebases and eleven
unrelated commits — two of which changed the live page the clips record. The committed
files are the last of the six. Ranges, not a pair, because a pair cannot tell a spread
from a fluke:

|                             | `planned-set`      | `dual-divergence`  |
| --------------------------- | ------------------ | ------------------ |
| duration                    | 33.32–33.36 s      | 36.96–37.00 s      |
| frames at 25 fps            | 833–834            | 924–925            |
| file size                   | 557–596 kB (±3.3%) | 512–571 kB (±5.4%) |
| narration length            | 24.405 s, all six  | 23.189 s, all six  |
| narration SHA-256           | identical, all six | identical, all six |
| video SHA-256               | all six differ     | all six differ     |
| sampled frames (3 per clip) | all differ         | all differ         |

So: duration and frame count repeat to within one frame, the narration track is
reproducible to the byte, encoded size swings by a few percent, and no frame is
byte-identical. That last part is expected and is why nothing gates on a pixel — the live
page paints a wall clock, and `libx264` is not deterministic across two encodes of
visually different input. The predicates, not the encoder, are what make the length
repeat, which is why the duration band in `clips.test.ts` is an honest check and a hash
would not be.

The renders also crossed two real changes to the page — #356 added an end-of-session stage
to the live view, #361 distinguished warm-up, probe and technique sets on the wall — with
every assertion still holding. That is the case the band was drawn for: neither change
lands inside the bracket a clip records, and the text watch is what would have caught it
if one had.

What proves a clip is not blank is therefore not its bytes: it is the text watch above,
plus three frames decoded out of the finished file and checked for being substantial and
for differing from one another. A frozen clip and a blank one both fail that.

### The staleness gate for clips

`clips.test.ts` mirrors the stills gate and adds the one thing a video needs. Verified by
mutation:

- Editing `planned-set.narration.txt` without re-rendering fails
  **`planned-set was voiced from the script that is checked in now`**. This is the failure
  mode that actually happens — prose edited to match a changed flow with the audio left
  saying the old thing — and nothing else in the build would notice it.
- Moving a clip's declared `route` fails **`was written by the definition that is checked
in now`** and **`planned-set was recorded from the route, predicates and assertions it
declares`**.

It also holds each clip to a real `ftyp` box, to the bytes recorded at capture time, to the
declared frame size and rate, to a duration band around a declared nominal, to the
narration ending before the video does, to a clips directory holding nothing undeclared,
and to both guides carrying the synthetic-narration notice and a link to the script.

The clip definition has its **own** hash, separate from `captureDefinitionHash()`. Editing
a clip must not invalidate six screenshots it never touched.

## Watching a page instead of capturing it (VW-416)

The same scenarios drive `npm run dashboard:preview`, which boots one of them and holds it
open in a browser instead of screenshotting it — the way to look at a wall page without a
Voltra or a PT session:

```bash
npm run dashboard:preview -- goals                  # #/goals, held until Ctrl-C
npm run dashboard:preview -- goals --state behind   # …in a chosen goal state
npm run dashboard:preview -- body                   # #/body, the capture's own seed
npm run dashboard:preview -- plan                   # #/plan, the capture's own driver
```

`body` and `plan` reuse `CAPTURE_SCENARIOS` verbatim, so what you browse is what the
published image was taken of. `goals` does not: a driven goal run can only ever land on
`calibrating`, because a band with no baseline past `SHAPE_ONLY` is the execution ramp by
construction. Its six `--state` seeds are defined in
[`src/docs/preview-seeds.ts`](../src/docs/preview-seeds.ts) and the status each one reaches
is pinned by `src/dashboard/__tests__/preview-seeds.test.ts`, so a read-model change that
moved one shows up as a failing test rather than as a page that no longer shows what its
flag says.

The launcher is shared rather than copied: `scripts/lib/dashboard-launch.mjs` owns the free
port, the scratch `VMCP_DB_PATH`, the MCP handshake and the bind wait for both commands.

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

The clips carry the same constraint over more surface, because a video has an audio track
and thirty seconds of frames rather than one. Same mock adapter, same isolated store, same
guard — run over the narration scripts too, since those are published as speech. The
narration is written prose about observable behaviour and names no register, offset or
command; keep it that way, and read the script as prose when a change touches device
behaviour, because no pattern can catch a sentence that explains a mechanism.
