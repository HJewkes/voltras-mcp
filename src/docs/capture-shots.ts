// The committed definition of every screenshot the docs site publishes.
//
// A screenshot in published documentation rots silently: the dashboard changes,
// the image does not, and nothing fails. This module is the half of the problem
// that CAN be gated. `scripts/capture-screens.mjs` reads it, produces one PNG
// per shot, and writes a manifest recording what it actually captured; the
// tests in `src/__tests__/docs/captures.test.ts` compare that manifest back
// against this definition. Change a shot without regenerating and the `test`
// job goes red — the same property `npm run docs:reference` has.
//
// What this CANNOT gate is the pixels. `scripts/capture-screens.mjs` freezes the
// clock and disables animations/transitions before every shot (VW-389), which
// makes `dashboard-cold`, `plan-builder`, `goals` and `body-week` — the four
// shots with no server-real-time field on the page — byte-identical across two
// runs on ONE machine. The other four still carry a value the SERVER computed
// from its own clock (a rep-shape curve's per-sample frame-decode timestamp, a
// pace ETA, a session start/end stamp) that no client-side freeze reaches; see
// `docs/screenshot-harness.md` for the exact split and the two-run proof, and
// `guardLocalOverwrite` in the harness for what stops one of those four from
// being silently replaced by an ordinary local run. Font hinting, GPU
// rasterisation and Skia antialiasing differ machine to machine on top of all
// of that, so a byte or perceptual comparison in CI would either fail
// constantly or be tuned until it could never fail. This ships neither. What CI
// checks instead: the definition, the manifest agreeing with it, the image
// geometry, the assertions each capture had to satisfy before it was written,
// and that no site page points at a shot that no longer exists.

import { createHash } from 'node:crypto';

/** Where the captures land, relative to the repo root. Served by VitePress at `/captures/`. */
export const CAPTURE_DIR = 'site/public/captures';

/** The manifest the tests read, written next to the PNGs. */
export const CAPTURE_MANIFEST = `${CAPTURE_DIR}/manifest.json`;

/**
 * 1440x900 — the smallest full-screen laptop size the wall dashboard is laid out
 * to fill, so nothing on the live page is cropped or reflowed into a narrow
 * variant. Deliberately not titan-design's 1200x900 / 1280x720: those are
 * component baselines at a size that has nothing to do with this surface.
 */
export const CAPTURE_VIEWPORT = { width: 1440, height: 900 } as const;

/** A capture viewport. The default is {@link CAPTURE_VIEWPORT}; a shot may override it. */
export interface CaptureViewport {
  readonly width: number;
  readonly height: number;
}

/**
 * The wall frame the body page is laid out for (VW-338). Its two `size="wall"`
 * figures are 480x960 each and they sit between two rails — at 1440 the rails
 * squeeze and at 900 the figures are cropped, so a capture at the default size
 * would publish a picture of a page nobody runs.
 */
export const WALL_VIEWPORT = { width: 1920, height: 1080 } as const;

/** An iPhone-class portrait frame — the `#/goals` phone layout (VW-356). */
export const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

/**
 * 1x. The docs site renders these into a ~700px content column, so a 1440px-wide
 * capture is already 2x there; a device scale factor of 2 would make it 4x and
 * quadruple the bytes of a published image for no visible gain (the live page's
 * velocity chart alone went from 0.2 MB to 1.9 MB when this was 2).
 */
export const CAPTURE_DEVICE_SCALE_FACTOR = 1;

/** Scenario names, each one no-hardware run. */
export type CaptureScenarioName = 'cold' | 'planned' | 'dual' | 'goals' | 'body';

/**
 * How a scenario is driven. `driver: null` boots `dist/bin.js` directly (nothing
 * connects, nothing opens) — the only way to hold the empty state still. The
 * workout scenarios reuse the established mock drivers rather than
 * re-implementing a workout, so `set.end` is always called and nothing is
 * stubbed at the HTTP layer. `body` is the one exception, and says why inline.
 *
 * `{port}` / `{controlPort}` are substituted at run time with probed-free ports,
 * so the definition (and its hash) carries no machine-specific value.
 */
export interface CaptureScenario {
  readonly name: CaptureScenarioName;
  readonly driver: string | null;
  readonly args: readonly string[];
}

export const CAPTURE_SCENARIOS: readonly CaptureScenario[] = [
  { name: 'cold', driver: null, args: [] },
  {
    name: 'planned',
    // The only driver that can show a prescription — `dashboard-sim` carries no
    // plan data and plain `dashboard-mock-drive` attaches none.
    driver: 'scripts/dashboard-plan-drive.mjs',
    // `--pinned-reps` is what makes the numbers in these images predictable:
    // every set is exactly 5 reps from a device parked before and after, so the
    // frame sequence is identical run to run (scripts/lib/mock-burst.mjs). The
    // 8s settle and 10s rest are the windows a screenshot lands in — during
    // both the device is parked, so the shot is taken against a STILL page
    // rather than racing a driver.
    args: [
      '--port={port}',
      '--control-port={controlPort}',
      '--sets=2',
      '--pinned-reps=5',
      '--settle-ms=8000',
      '--rest-ms=10000',
    ],
  },
  {
    name: 'dual',
    driver: 'scripts/dashboard-mock-drive.mjs',
    // Asymmetric on purpose: equal sides prove nothing about the diverging
    // stage. Pinned, the asymmetry is exact — 6 reps against 4, every run.
    // ONE set: `live-dual-mid-set` is the only shot this scenario owns, and a
    // second set pinned to the SAME target reps made the `set-open` predicate
    // ambiguous between the two sets' parked windows — whichever one the
    // capture actually landed on rendered a different `liveRepIndex` /
    // velocity-curve state, so two runs on one machine disagreed on the PNG
    // even with the content assertions both passing (VW-389).
    args: [
      '--dual',
      '--port={port}',
      '--control-port={controlPort}',
      '--sets=1',
      '--pinned',
      '--reps=left:6,right:4',
      '--lag=right:2500',
      '--settle-ms=14000',
    ],
  },
  {
    name: 'goals',
    driver: 'scripts/dashboard-mock-drive.mjs',
    // The PR-star loop (VW-384): seeds one prior-week reading, declares the
    // lift a priority, accepts the coach's proposed band, then drives a
    // working set and a heavier set that passes it — the reading the goals
    // page's PR badge and trajectory chart need (VW-389).
    // Two companion lifts at `maintain` give the page its Per-lift section, which
    // never lists the lead (VW-467). The tricep extension lists first so its long
    // name wraps inside the phone shot's viewport.
    args: [
      '--goal=cable-chest-press',
      '--goal-companions=cable-overhead-tricep-extension:40,cable-row:100',
      '--port={port}',
      '--control-port={controlPort}',
    ],
  },
  {
    name: 'body',
    // The one scenario that does NOT drive the pipeline, and it cannot: every
    // driver runs `VOLTRA_ADAPTER=mock`, `set.end` stamps those sets
    // `source: 'mock'`, and the per-muscle read models exclude mock sets by
    // design (`read-models/muscle-set-scope.ts`) so synthetic work never reads
    // as this athlete's volume. A mock-driven body page is therefore correctly,
    // and uselessly, empty. This driver seeds recorded outcomes into the store
    // instead and boots the same server; the analytics over them are real.
    driver: 'scripts/dashboard-body-seed.mjs',
    args: [],
  },
];

/**
 * The state a shot waits for, polled off `/api/snapshot` (and `/api/history`)
 * — the same JSON the SPA itself polls. Never a sleep: the drivers are
 * time-driven, and a blank dashboard renders without throwing, so a fixed delay
 * would produce an empty PNG and no error.
 */
export type CaptureWait =
  /** Server up, nothing connected, no session. */
  | { readonly kind: 'idle' }
  /**
   * A set is open on every listed slot and holds EXACTLY that slot's rep count.
   * Exact, not a floor: the driver pins each set to a fixed burst and parks the
   * device afterwards, so the shot must land on the parked state. A `>=` here
   * would fire mid-burst and screenshot a moving page — the defect this whole
   * value layer exists to remove.
   */
  | { readonly kind: 'set-open'; readonly reps: readonly (readonly [string, number])[] }
  /** Session live, no set open, at least one set already logged — the rest stage. */
  | { readonly kind: 'rest' }
  /** No session open and at least `minSessions` sessions in history. */
  | { readonly kind: 'sessions-ended'; readonly minSessions: number }
  /** The plan tree carries a program with at least `minExercises` planned lifts. */
  | { readonly kind: 'plan-seeded'; readonly minExercises: number };

export interface CaptureShot {
  /** Also the PNG basename and the id a guide embeds. */
  readonly name: string;
  readonly scenario: CaptureScenarioName;
  /** Path plus hash route, relative to the dashboard origin. */
  readonly route: string;
  /** Alt text for the guide that embeds it. Published, so it is guarded too. */
  readonly caption: string;
  readonly waitFor: CaptureWait;
  /**
   * Strings that must be present in the rendered page after the capture, matched
   * case-sensitively against the page text with runs of whitespace collapsed to
   * one space (the DOM puts a label and its value in separate blocks, so raw
   * `innerText` would need embedded newlines to assert the pair). This is what
   * proves the PNG is not blank: a dashboard that failed to mount, lost its
   * stylesheet or rendered an empty stage still screenshots cleanly and throws
   * nothing.
   */
  readonly expectText: readonly string[];
  /**
   * The DATA on the page, pinned. Same matching as `expectText` — these are
   * simply the strings that carry numbers the pipeline computed rather than
   * labels the markup hard-codes, and they are the half `expectText` cannot
   * check: a panel that renders a wrong number, or a NaN, still contains every
   * label it always did.
   *
   * Every value here is deterministic because the driver pins the input: a
   * fixed burst of reps from a device parked on both sides of it, so the frame
   * sequence the analytics sees is identical run to run
   * (scripts/lib/mock-burst.mjs).
   *
   * DELIBERATELY NOT ASSERTED, because they are still not deterministic:
   *   - the header wall clock, and the session-summary start/end stamps and
   *     `DURATION` — real time, moving.
   *   - the rest countdown (`VMCP_REST_TIMER=on`) — counting down as the shot
   *     is taken.
   *   - anything derived from frame timestamps (tempo seconds, set duration):
   *     a frame is stamped with `Date.now()` at decode, so its VALUES repeat
   *     across runs but its CLOCK does not.
   * An assertion on any of those would have to be loose enough to pass on a
   * moving value, which is the defect, not the fix.
   */
  readonly expectValues: readonly string[];
  /**
   * True when the view is assembled from transitions the SPA observes while it
   * is open. The live page derives its completed-set columns from `sets.active`
   * going non-null -> null across two polls, so a page loaded after that already
   * happened renders an empty rest stage. Those shots open the route BEFORE the
   * predicate and are never reloaded. Every other page fetches once on mount, so
   * it must be opened AFTER the predicate holds or it shows whatever was true
   * when it mounted and never updates.
   */
  readonly holdsPageOpen: boolean;
  /** Overrides {@link CAPTURE_VIEWPORT} for this shot alone. @see viewportFor */
  readonly viewport?: CaptureViewport;
}

/** The viewport a shot is taken at — its own, or the default. */
export function viewportFor(shot: CaptureShot): CaptureViewport {
  return shot.viewport ?? CAPTURE_VIEWPORT;
}

/**
 * The goals scenario's computed numbers, shared by its wall and phone shots:
 * both read the same pipeline state, so a wrong number fails both.
 */
const GOALS_VALUES: readonly string[] = [
  // The block-end target, fixed by the seeded prior-week reading (100 lb x 8)
  // and the coach's own proposal. Never asserted as a raw number elsewhere,
  // so a wrong target here would pass every other shot's check.
  'Goal 8 x 133 lb',
  // The driven PR set as the block's best, and the gap it leaves to the goal.
  'Best 8 x 110 lb',
  '23 lb to goal',
  // The whole-body panel's own line for the same priority.
  'CABLE CHEST PRESS · specialize',
];

/**
 * Order matters within a scenario: shots are taken in listed order against one
 * run, so each `waitFor` must be reachable at or after the previous one. The
 * planned run ends with the two post-run pages, which stay put while the driver
 * holds — nothing later has to race anything earlier.
 */
export const CAPTURE_SHOTS: readonly CaptureShot[] = [
  {
    name: 'dashboard-cold',
    scenario: 'cold',
    route: '/app',
    caption: 'The wall dashboard before a Voltra is connected.',
    waitFor: { kind: 'idle' },
    expectText: ['No Voltra connected', 'VELOCITY · this set'],
    expectValues: ['Session 0/0 sets'],
    holdsPageOpen: false,
  },
  {
    name: 'live-mid-set',
    scenario: 'planned',
    route: '/app',
    caption: 'The live page mid-set, with the prescribed sets, reps, load and tempo attached.',
    // The whole pinned burst, with the device parked on it: the velocity chart
    // and the fatigue verdict have their full five reps and nothing is moving.
    waitFor: { kind: 'set-open', reps: [['primary', 5]] },
    expectText: ['Push A · Hypertrophy', 'Cable Chest Press', 'VELOCITY · this set', 'FATIGUE'],
    expectValues: [
      // The prescription, walked out of the real plan store by the driver.
      'Cable Chest Press 3 × 8–10 @ 140 lbs',
      '0/8 sets',
      // The velocity chart's per-rep peaks — the pipeline's own output, and the
      // reason the burst has to be pinned: these moved every run before it.
      'VL 20% VL 30% 0.50 0.49 0.47 0.46',
      // The readout that caught this: two runs of the OLD harness disagreed
      // here (5.5 "Good" against 6.0 "Slowing") and both were green.
      'FATIGUE 5.0 RPE Good',
    ],
    holdsPageOpen: true,
  },
  {
    name: 'live-rest',
    scenario: 'planned',
    route: '/app',
    caption: 'The rest stage between two sets of a planned exercise.',
    waitFor: { kind: 'rest' },
    expectText: ['TONNAGE', 'Cable Chest Press', 'Push A · Hypertrophy'],
    expectValues: [
      'VOLUME 5 TONNAGE 0 lbs',
      '1/8 sets',
      // Tonnage is 0 and load is `—` because the mock emits no settings
      // cascade, so the dashboard never learns a weight. That degradation is
      // real and pinned here on purpose — see dashboard-plan-drive's header.
      'SET REPS LBS RPE 1 5 0 —',
      'SET VERDICT 5 Reps 0 lbs 12%',
      'Next · Cable Chest Press · set 2 of 3',
    ],
    holdsPageOpen: true,
  },
  {
    name: 'session-summary',
    scenario: 'planned',
    route: '/app#/summary',
    caption: 'The session-completion screen for the session that just ended.',
    waitFor: { kind: 'sessions-ended', minSessions: 3 },
    expectText: ['Session complete', 'EXERCISES', 'NEXT SESSION'],
    expectValues: [
      // `DURATION` sits between `VOLUME` and its value and is deliberately not
      // asserted: it is wall-clock, unlike everything before it.
      'EXERCISES 1 SETS 2 REPS 10 VOLUME —',
      'FATIGUE 5.0 RPE Good',
      'RIR 4.8',
      'BEST VELOCITY 0.5',
      '12% peak-to-last within a set — set #2, the set the verdict above reads.',
      'RECOMMENDATION -5 lb TARGET LOAD 40 lb',
      '#1 5 × — loss 12% best 0.5 #2 5 × — loss 12% best 0.5',
    ],
    holdsPageOpen: false,
  },
  {
    name: 'plan-builder',
    scenario: 'planned',
    route: '/app#/plan',
    caption: 'The plan builder, showing a seeded workout template and the exercise catalog.',
    waitFor: { kind: 'plan-seeded', minExercises: 3 },
    expectText: ['Push A — planned exercises', 'Cable Incline Chest Press', 'Save targets'],
    expectValues: [
      '30 exercises',
      'Push A Block 1 · Week 1 · 3 exercises completed',
      '1. Cable Chest Press 3 × 8-10 · @ 140 lb · 90s rest',
      '2. Cable Incline Chest Press 3 × 10 · @ 95 lb · 75s rest',
      '3. Cable Chest Fly 2 × 12-15 · @ 45 lb · 60s rest',
    ],
    holdsPageOpen: false,
  },
  {
    name: 'live-dual-mid-set',
    scenario: 'dual',
    route: '/app?variant=live-dual',
    caption: 'The diverging stage mid-set, with two Voltras bound to the left and right slots.',
    waitFor: {
      kind: 'set-open',
      reps: [
        ['left', 6],
        ['right', 4],
      ],
    },
    expectText: ['MOCK-VOLTRA-LEFT', 'MOCK-VOLTRA-RIGHT', 'L/R'],
    expectValues: [
      // Both sides' per-rep peaks in one string, so a slot that stopped
      // updating or started mirroring its neighbour cannot pass. Six values
      // left, four right — the scenario's own asymmetric target.
      'VL 20% VL 30% 0.50 0.49 0.47 0.46 0.44 0.43 VL 20% VL 30% 0.50 0.49 0.47 0.46',
      'L/R 2% Right leading',
    ],
    // Unlike the other live-page shots, this is the ONLY shot in the `dual`
    // scenario, so there is no later shot's continuity to preserve by holding
    // the page open early. Opening early used to race the mock adapter's
    // connect-time rep against the wall dashboard's kiosk auto-navigate
    // (`SessionEndedView`, VW-261): that rep set `model.live` before
    // `session.start` landed, which read as "session ended" and, after its
    // 8s timer, auto-navigated to `#/summary` mid-capture — a 404 on
    // `/api/session-summary/latest` for the session that hadn't finished yet
    // (VW-389). The diverging stage's data (`entry.sets.active.reps`) comes
    // straight off the snapshot poll, not off accumulated SSE, so a page
    // opened fresh after the predicate holds renders the same content.
    holdsPageOpen: false,
  },
  {
    name: 'goals',
    scenario: 'goals',
    route: '/app#/goals',
    caption:
      'The goal-coach wall page, with an accepted target and a personal record from the heavier set.',
    // 4: the goal driver seeds one PREVIOUS-week session per lift (the lead and
    // its two companions) directly into the store before the server even opens,
    // so any count up to 3 was satisfied at server startup, before
    // `goal.declare_priorities` ever ran — the shot opened on an empty
    // "No priorities declared" page (VW-389). The fourth is the driven session.
    waitFor: { kind: 'sessions-ended', minSessions: 4 },
    expectText: ['CABLE CHEST PRESS', 'Calibrating', 'to goal', 'PER-LIFT', 'Whole body'],
    expectValues: GOALS_VALUES,
    holdsPageOpen: false,
  },
  {
    name: 'goals-phone',
    scenario: 'goals',
    route: '/app#/goals',
    caption: 'The goal-coach page at phone width, cards and chart stacked to one column.',
    // Same state as `goals` — this shot proves the phone layout (VW-356), not
    // a different read of the pipeline, so it reuses that shot's predicate
    // and content rather than re-deriving one.
    waitFor: { kind: 'sessions-ended', minSessions: 4 },
    viewport: PHONE_VIEWPORT,
    expectText: ['CABLE CHEST PRESS', 'Calibrating', 'to goal', 'PER-LIFT', 'Whole body'],
    expectValues: GOALS_VALUES,
    holdsPageOpen: false,
  },
  {
    name: 'body-week',
    scenario: 'body',
    route: '/app#/body',
    caption:
      "The body page: a training week's volume per muscle, what is due next, and recent PRs.",
    // The seed is written before the server boots, so this holds from the first
    // poll — it is here to fail loudly if the seed ever writes fewer sessions.
    waitFor: { kind: 'sessions-ended', minSessions: 18 },
    viewport: WALL_VIEWPORT,
    expectText: ['Next up', 'Recent PRs', 'This week', 'Legend', 'Weekly sets by muscle'],
    expectValues: [
      // The four glance tiles with their own labels: swapping two tiles' data
      // sources leaves every one of these numbers on the page, and this string
      // still fails.
      'SETS 32 MUSCLES 7 PRODUCTIVE 1',
      'BELOW MEV 11 OVER MRV 0',
      // The one muscle over its MAV and the one still under its MEV, off the
      // strip — the two ends of the status scale the figure paints.
      'Chest 15/14',
      'Lats 4/14',
      // A PR the strength read model found, not one the seed declared.
      'Cable Chest Press Chest 221.7 lb (+12.7)',
      // The plan's remaining work, folded to one row per lift.
      'Cable Lat Pulldown Pull B 4 sets',
    ],
    holdsPageOpen: false,
  },
];

/**
 * A stable fingerprint of everything above. The manifest records it, and a test
 * fails when the two disagree — which is what makes "someone edited a shot and
 * never regenerated" a red build instead of a stale image on a public page.
 */
export function captureDefinitionHash(): string {
  const canonical = JSON.stringify({
    viewport: CAPTURE_VIEWPORT,
    deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
    scenarios: CAPTURE_SCENARIOS,
    shots: CAPTURE_SHOTS,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
