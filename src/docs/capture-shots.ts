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
// What this CANNOT gate is the pixels. Two machines render the same page
// differently (font hinting, GPU rasterisation, Skia antialiasing), and two runs
// on ONE machine still differ because the dashboard paints a wall clock and a
// count-up rest timer. A byte or perceptual comparison of the images would
// either fail constantly or be tuned until it could never fail, so this ships
// neither. What is checked instead: the definition, the manifest agreeing with
// it, the image geometry, the assertions each capture had to satisfy before it
// was written, and that no site page points at a shot that no longer exists.

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

/**
 * 1x. The docs site renders these into a ~700px content column, so a 1440px-wide
 * capture is already 2x there; a device scale factor of 2 would make it 4x and
 * quadruple the bytes of a published image for no visible gain (the live page's
 * velocity chart alone went from 0.2 MB to 1.9 MB when this was 2).
 */
export const CAPTURE_DEVICE_SCALE_FACTOR = 1;

/** Scenario names, each one no-hardware run of the real MCP pipeline. */
export type CaptureScenarioName = 'cold' | 'planned' | 'dual';

/**
 * How a scenario is driven. `driver: null` boots `dist/bin.js` directly (nothing
 * connects, nothing opens) — the only way to hold the empty state still. The
 * other two reuse the established mock drivers rather than re-implementing a
 * workout, so `set.end` is always called and nothing is stubbed at the HTTP layer.
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
    args: [
      '--dual',
      '--port={port}',
      '--control-port={controlPort}',
      '--sets=2',
      '--pinned',
      '--reps=left:6,right:4',
      '--lag=right:2500',
      '--settle-ms=14000',
    ],
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
}

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
      // updating or started mirroring its neighbour cannot pass.
      'VL 20% VL 30% 0.50 0.49 0.47 0.46 0.44 VL 20% VL 30% 0.50 0.49 0.47 0.46',
      'L/R 2% Right leading',
    ],
    holdsPageOpen: true,
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
