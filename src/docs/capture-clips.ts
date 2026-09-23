// The committed definition of every narrated screen recording the docs site
// publishes — the moving half of `capture-shots.ts`.
//
// A video rots worse than a screenshot. A reader can skim a still and notice it
// looks wrong; nobody notices a 30-second clip is lying until they have watched
// 30 seconds. So a clip here is built exactly like a shot: a committed
// definition, predicates over `/api/snapshot` rather than sleeps, assertions on
// the page text taken WHILE the camera runs, and a manifest the test suite holds
// against this file.
//
// ── Why this is a separate module from capture-shots.ts ────────────────────
// `captureDefinitionHash()` covers the shots, and the committed PNGs are pinned
// to it. Adding clips to that hash would invalidate six screenshots that nothing
// about this change touches. Clips get their own {@link clipDefinitionHash} over
// their own scenarios and constants, and both hashes land in the one manifest.
//
// ── What "reproducible" means here, and what it does not ───────────────────
// The frames are reproducible in the same sense the stills are: the drivers pin
// each set to an exact burst from a parked mock device, so the values on screen
// repeat run to run (scripts/lib/mock-burst.mjs). The FILE is not byte-identical
// between runs and cannot be — the page paints a wall clock, and the encoder is
// not deterministic across runs of different length. What repeats is the
// content: same stages, same numbers, same narration, duration within a declared
// band. `docs/screenshot-harness.md` records what was measured.

import { createHash } from 'node:crypto';
import { CAPTURE_DIR, type CaptureScenario, type CaptureWait } from './capture-shots.js';

/** Where the clips land. A subdirectory of the stills' tree: one published folder, not two. */
export const CLIP_DIR = `${CAPTURE_DIR}/clips`;

/**
 * Where a narration script lives: beside the guide that embeds the clip, as
 * plain text. Beside, and not in the capture directory, because the script and
 * the guide prose describe the same flow and should be edited in one place.
 */
export const NARRATION_DIR = 'site/guides';

/**
 * 1280x800 — exactly 8/9 of the stills' 1440x900 viewport in both axes. The
 * BROWSER still runs at 1440x900, because that is the smallest size the wall
 * dashboard is laid out to fill without reflowing into a narrow variant; only
 * the encode is scaled down. An exact 8/9 keeps the aspect ratio, so nothing is
 * letterboxed, and drops 21% of the pixels from a file that ships in the repo.
 */
export const CLIP_SIZE = { width: 1280, height: 800 } as const;

/** 25 fps: what Playwright's screencast emits. Re-encoding at any other rate resamples for nothing. */
export const CLIP_FPS = 25;

/**
 * H.264 constant-rate-factor 30. The dashboard is flat dark panels and text,
 * which holds at 30 where photographic content would not; 23 (the usual default)
 * roughly tripled the committed bytes for no difference visible in the guide's
 * content column.
 */
export const CLIP_VIDEO_CRF = 30;

/** 64 kbit/s AAC. The narration is mono 24 kHz synthetic speech; more bits do not make it clearer. */
export const CLIP_AUDIO_BITRATE_KBPS = 64;

/**
 * How long the camera keeps running after the end predicate fires. The predicate
 * is true the instant the STATE changes; the stage it names still has to reach
 * the SPA's next poll and paint, and then a viewer has to be able to read it.
 */
export const CLIP_LEAD_OUT_MS = 6000;

/**
 * The narration must finish this far before the video does. The mux stream-copies
 * the track and never pads it, so a narration that overran would reach a reader as
 * a word cut off mid-sentence — this turns that into a hard error instead.
 */
export const NARRATION_HEADROOM_MS = 2000;

/**
 * Ceiling on a committed clip. This repo is public and a video is the largest
 * thing in it; a clip that needs more than this is a clip that should be
 * shorter, not a file that should be bigger.
 */
export const CLIP_MAX_BYTES = 4_000_000;

/**
 * The duration a clip is expected to land in. Predicate-driven, so it is a band
 * and not a number: poll granularity, page mount and encoder tail all move it by
 * a fraction of a second. Narrow enough that a clip which collapsed to its lead-out
 * or ran away with a stuck driver fails the test.
 */
export const CLIP_DURATION_TOLERANCE_S = 5;

/** The voice `hyperframes tts` is asked for. Pinned so a re-render sounds like the committed take. */
export const NARRATION_VOICE = 'am_michael';

/**
 * The line every guide embedding a clip has to carry, asserted by the clip test.
 * Synthetic narration is a deliberate choice — a script in the repo can be
 * re-rendered when the flow changes and a human take cannot — and saying so on
 * the page costs nothing and is true.
 */
export const SYNTHETIC_NARRATION_NOTICE =
  'The narration is synthetic speech, generated from a script in this repository.';

/** Clips run their own scenarios: the stills' argument sets are tuned for a still page, not a moving one. */
export type ClipScenarioName = 'planned-clip' | 'dual-clip';

/** A stills scenario with the clip name set. Same shape, same `{port}` substitution, same drivers. */
export interface ClipScenario extends Omit<CaptureScenario, 'name'> {
  readonly name: ClipScenarioName;
}

export const CLIP_SCENARIOS: readonly ClipScenario[] = [
  {
    name: 'planned-clip',
    // Still the only driver that can show a prescription.
    driver: 'scripts/dashboard-plan-drive.mjs',
    // Eight pinned reps rather than the stills' five: a burst is ~2.9 s per rep,
    // and five of them is a clip too short to narrate. The 6 s settle is the
    // window where the set sits complete and parked before it closes, and the
    // 12 s rest is long enough for the rest stage to be read after it does.
    args: [
      '--port={port}',
      '--control-port={controlPort}',
      '--sets=2',
      '--pinned-reps=8',
      '--settle-ms=6000',
      '--rest-ms=12000',
    ],
  },
  {
    name: 'dual-clip',
    driver: 'scripts/dashboard-mock-drive.mjs',
    // 8 against 5 with the right side 3.5 s late: the gap has to be visible as
    // it opens, not merely present at the end, which is the whole point of the
    // diverging stage. Both sides are pinned, so the gap is the same gap every run.
    args: [
      '--dual',
      '--port={port}',
      '--control-port={controlPort}',
      '--sets=2',
      '--pinned',
      '--reps=left:8,right:5',
      '--lag=right:3500',
      // 9 s, not the stills' shorter settle: each slot settles after its OWN
      // burst, and the right side's burst is three reps shorter. A settle below
      // ~6 s closes the right set before the left reaches its eighth rep, and
      // the one frame where both charts are full never exists.
      '--settle-ms=9000',
      '--rest-ms=12000',
    ],
  },
];

/**
 * Extra predicates clips need that stills do not. A still lands on a parked
 * state and so wants an EXACT rep count; a clip has to start while the page is
 * moving, so it wants a floor — and it has to end on a dual-slot rest, which the
 * single-slot `rest` predicate cannot see (each slot carries its own sets).
 */
export type ClipWait =
  | CaptureWait
  /** A set is open on every listed slot and holds AT LEAST that slot's rep count. */
  | { readonly kind: 'set-open-min'; readonly reps: readonly (readonly [string, number])[] }
  /** Every listed slot has no open set and at least one logged — the dual rest stage. */
  | { readonly kind: 'slots-rest'; readonly slots: readonly string[] };

export interface CaptureClip {
  /** Also the basename of the video, the narration script and the id a guide embeds. */
  readonly name: string;
  readonly scenario: ClipScenarioName;
  /** Path plus hash route, relative to the dashboard origin. */
  readonly route: string;
  readonly caption: string;
  /**
   * When the camera opens the page. Never `idle` and never a sleep: recording
   * starts the moment the page does, so a clip whose page opened before the
   * dashboard had data opens on a blank stage — and a blank dashboard renders
   * perfectly cleanly and throws nothing.
   */
  readonly startWhen: ClipWait;
  /** When the camera stops, plus {@link CLIP_LEAD_OUT_MS}. */
  readonly endWhen: ClipWait;
  /** The narration script, under {@link NARRATION_DIR}. The source of the audio, never the other way round. */
  readonly narrationFile: string;
  /** The site page that embeds this clip. Must carry {@link SYNTHETIC_NARRATION_NOTICE}. */
  readonly guide: string;
  /**
   * Labels the markup hard-codes, which must be on the page at some point WHILE
   * the camera runs — sampled from the same poll loop the end predicate uses.
   * This is what proves the video is not 30 seconds of blank stage.
   */
  readonly expectText: readonly string[];
  /**
   * Numbers the pipeline computed, sampled the same way. Labels survive a panel
   * that renders a wrong value; these do not. Nothing wall-clock is listed —
   * the header clock, the rest countdown and anything derived from frame
   * timestamps move while the camera is running, by design.
   */
  readonly expectValues: readonly string[];
  /** Nominal length in seconds, held to {@link CLIP_DURATION_TOLERANCE_S} by the test. */
  readonly nominalSeconds: number;
}

export const CAPTURE_CLIPS: readonly CaptureClip[] = [
  {
    name: 'planned-set',
    scenario: 'planned-clip',
    route: '/app',
    caption: 'A working set on the live page, with the plan prescription attached.',
    // One rep in: the prescription and the header lockup have rendered and the
    // first rep is on the velocity chart, so the clip opens on a live page and
    // the remaining seven land on camera.
    startWhen: { kind: 'set-open-min', reps: [['primary', 1]] },
    endWhen: { kind: 'rest' },
    narrationFile: 'planned-set.narration.txt',
    guide: 'site/guides/planned-session.md',
    expectText: [
      'Push A · Hypertrophy',
      'Cable Chest Press',
      'VELOCITY · this set',
      'FATIGUE',
      'TONNAGE',
    ],
    expectValues: [
      // The prescription, walked out of the real plan store by the driver.
      'Cable Chest Press 3 × 8–10 @ 140 lbs',
      // The last of the eight pinned reps: present only if the whole burst
      // landed on camera, which is what this clip is for.
      '0.50 0.49 0.47 0.46 0.44 0.43 0.41 0.40',
      // The rest stage the end predicate waits for, as the page renders it: the 8
      // pinned reps at the 140 lb the mock reports, through the rail tile's own
      // formatter, which abbreviates a total of 1000 or more.
      'VOLUME 8 TONNAGE 1.1k lbs',
    ],
    nominalSeconds: 33,
  },
  {
    name: 'dual-divergence',
    scenario: 'dual-clip',
    route: '/app?variant=live-dual',
    caption:
      'Two Voltras on the left and right slots diverging through a set, then falling through to rest.',
    // The left slot's first rep, which lands while the right is still inside its
    // lag — so the gap is open in the first frame rather than appearing later.
    startWhen: { kind: 'set-open-min', reps: [['left', 1]] },
    endWhen: { kind: 'slots-rest', slots: ['left', 'right'] },
    narrationFile: 'dual-divergence.narration.txt',
    guide: 'site/guides/bilateral.md',
    expectText: ['MOCK-VOLTRA-LEFT', 'MOCK-VOLTRA-RIGHT', 'L/R', 'CON ECC', 'TONNAGE'],
    expectValues: [
      // Both sides' per-rep peaks in one string, in the one order the diverging
      // stage renders them. A slot that stopped updating or started mirroring
      // its neighbour cannot produce this.
      //
      // Seven labels on the left against five on the right, for eight reps and
      // five: the stage suppresses the label on the LIVE rep, and its live index
      // is the max across both slots (`fatigue-view.ts`). So the left side, which
      // is still open and one rep ahead, hides its eighth; the right side, whose
      // indices never reach that far, shows all of its own.
      'VL 20% VL 30% 0.50 0.49 0.47 0.46 0.44 0.43 0.41 VL 20% VL 30% 0.50 0.49 0.47 0.46 0.44',
    ],
    nominalSeconds: 37,
  },
];

/**
 * A stable fingerprint of the clip definition, recorded in the manifest and
 * checked by `src/__tests__/docs/clips.test.ts`. Deliberately separate from
 * `captureDefinitionHash()`: editing a clip must not invalidate a screenshot.
 */
export function clipDefinitionHash(): string {
  const canonical = JSON.stringify({
    size: CLIP_SIZE,
    fps: CLIP_FPS,
    crf: CLIP_VIDEO_CRF,
    audioKbps: CLIP_AUDIO_BITRATE_KBPS,
    leadOutMs: CLIP_LEAD_OUT_MS,
    voice: NARRATION_VOICE,
    scenarios: CLIP_SCENARIOS,
    clips: CAPTURE_CLIPS,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * A narration script as it is actually spoken: every whitespace run collapsed to
 * one space. Line wrapping in the file is a reading convenience and must not
 * change the audio or its hash.
 */
export function narrationText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** The fingerprint of one spoken script, so an edited script without a re-render is a red build. */
export function narrationHash(spoken: string): string {
  return createHash('sha256').update(spoken).digest('hex');
}
