/**
 * State-driven single/dual stage selection (VMCP-04.07).
 *
 * The dual stage used to be reachable only by hand-typing `?variant=live-dual`. These
 * lock the rule that replaced it — BOTH limb slots bound ⇒ diverging, anything else ⇒
 * single — plus the two TRANSITIONS that are the point of the ticket: a second Voltra
 * joining mid-session, and one dropping.
 *
 * The transition cases are written as SEQUENCES of snapshots rather than as independent
 * point checks, because "did the page swap at the right moment, carrying data with it" is
 * a property of the sequence. The last block asserts the no-blank-frame criterion at the
 * model layer: at every step, the models the chosen stage needs are non-null.
 */
import { describe, expect, it } from 'vitest';
import {
  initialAccumulatorState,
  type Snapshot,
  type SnapshotDeviceEntry,
} from '../spa/adapter.js';
import { type LiveViewSources } from '../spa/panels/live-view.js';
import {
  mapStoreToDivergingHeroModel,
  mapStoreToFatigueModel,
} from '../spa/panels/fatigue-view.js';
import { hasBoundSide } from '../spa/live-page/diverging-stage-model.js';
import {
  boundLimbSides,
  isSlotBound,
  readVariantOverride,
  selectLiveVariant,
} from '../spa/live-page/stage-variant.js';

// --- Fixtures ----------------------------------------------------------------

/** A slot entry with an OPEN set — the mid-lift shape every case below cares about. */
function slot(
  slotId: string,
  over: Partial<SnapshotDeviceEntry['device']> = {},
): SnapshotDeviceEntry {
  return {
    slotId,
    device: { connected: true, deviceId: `V-${slotId}`, ...over },
    sets: { active: { setId: `set-${slotId}`, reps: [] }, completed: [] },
  } as SnapshotDeviceEntry;
}

function snapshotWith(devices: SnapshotDeviceEntry[]): Snapshot {
  const firstActive = devices.find((d) => d.sets?.active)?.sets?.active ?? null;
  return {
    session: { sessionId: 'sess-1', exerciseName: 'Barbell Bench Press' },
    devices,
    // Mirrors the server: the top-level set is the first slot that HAS one, which is what
    // the single stage reads. See `buildSnapshot` in dashboard/server.ts.
    sets: { active: firstActive, completed: [] },
  };
}

function sources(snapshot: Snapshot | null): LiveViewSources {
  return {
    snapshot,
    accumulator: initialAccumulatorState(),
    live: null,
    prescription: null,
  };
}

const bilateral = snapshotWith([slot('left'), slot('right')]);
const bench = snapshotWith([slot('primary')]);

// --- Steady states -----------------------------------------------------------

describe('selectLiveVariant — steady states', () => {
  it('picks the DUAL stage when both limb slots are bound', () => {
    expect(selectLiveVariant(bilateral, null)).toBe('live-dual');
  });

  it('picks the SINGLE stage for an ordinary bench session on `primary`', () => {
    // Neither limb slot exists, so the diverging stage would draw an empty axis and an
    // "awaiting both" note while the athlete is mid-lift.
    expect(selectLiveVariant(bench, null)).toBe('live');
  });

  it('picks the SINGLE stage when only ONE limb slot is bound', () => {
    // A half-drawn bilateral chart would cost the session the telemetry it DOES have.
    expect(selectLiveVariant(snapshotWith([slot('left')]), null)).toBe('live');
    expect(selectLiveVariant(snapshotWith([slot('right')]), null)).toBe('live');
  });

  it('picks the SINGLE stage with no devices at all, and before the first snapshot', () => {
    expect(selectLiveVariant(snapshotWith([]), null)).toBe('live');
    expect(selectLiveVariant(null, null)).toBe('live');
  });

  it('ignores a non-limb slot sitting alongside one limb', () => {
    // `primary` + `right` is not a bilateral rig; it is one Voltra plus a stray binding.
    expect(selectLiveVariant(snapshotWith([slot('primary'), slot('right')]), null)).toBe('live');
  });
});

describe('isSlotBound / boundLimbSides', () => {
  it('reports the bound limbs in stable left-then-right order regardless of device order', () => {
    expect(boundLimbSides(snapshotWith([slot('right'), slot('left')]))).toEqual(['left', 'right']);
  });

  it('treats an explicitly DISCONNECTED slot as unbound', () => {
    expect(isSlotBound(slot('left', { connected: false }))).toBe(false);
  });

  it('treats a slot whose snapshot never carried the flag as bound', () => {
    // `connected` is optional on the wire (older server / hand-built fixture). Unknown must
    // not silently disable the bilateral stage on real hardware.
    expect(isSlotBound({ slotId: 'left', device: {} })).toBe(true);
  });

  it('treats a missing slot as unbound', () => {
    expect(isSlotBound(undefined)).toBe(false);
  });
});

// --- Transitions -------------------------------------------------------------

/** The variant at each step of a snapshot sequence. */
function variantSequence(steps: (Snapshot | null)[]): string[] {
  return steps.map((s) => selectLiveVariant(s, null));
}

describe('selectLiveVariant — transitions', () => {
  it('swaps SINGLE → DUAL the frame a second Voltra binds mid-session', () => {
    expect(
      variantSequence([
        snapshotWith([slot('left')]),
        snapshotWith([slot('left')]),
        snapshotWith([slot('left'), slot('right')]),
        snapshotWith([slot('left'), slot('right')]),
      ]),
    ).toEqual(['live', 'live', 'live-dual', 'live-dual']);
  });

  it('swaps DUAL → SINGLE the frame a slot is released', () => {
    expect(
      variantSequence([snapshotWith([slot('left'), slot('right')]), snapshotWith([slot('left')])]),
    ).toEqual(['live-dual', 'live']);
  });

  it('swaps DUAL → SINGLE on a BLE drop that leaves the slot bound but silent', () => {
    // The slot entry survives a disconnect, so presence alone would keep a frozen wing on
    // screen and read as a very asymmetric lift rather than as a lost device.
    expect(
      variantSequence([
        bilateral,
        snapshotWith([slot('left'), slot('right', { connected: false })]),
      ]),
    ).toEqual(['live-dual', 'live']);
  });

  it('returns to DUAL when the dropped device reconnects', () => {
    expect(
      variantSequence([
        bilateral,
        snapshotWith([slot('left'), slot('right', { connected: false })]),
        bilateral,
      ]),
    ).toEqual(['live-dual', 'live', 'live-dual']);
  });

  it('carries no memory of the previous variant', () => {
    // Selection is a pure function of the CURRENT snapshot. A remembered variant would be
    // wrong at exactly the two moments above — it would keep drawing a slot that has gone.
    expect(selectLiveVariant(bench, null)).toBe(selectLiveVariant(bench, null));
    expect(variantSequence([bilateral, bench])).toEqual(['live-dual', 'live']);
  });
});

// --- No blank frame ----------------------------------------------------------

describe('the stage swapped TO always has something to draw', () => {
  it('hands the dual stage a bound side, and the single stage an open set, across a drop', () => {
    const steps = [bilateral, snapshotWith([slot('left')])];
    for (const snapshot of steps) {
      const src = sources(snapshot);
      if (selectLiveVariant(snapshot, null) === 'live-dual') {
        expect(hasBoundSide(mapStoreToDivergingHeroModel(src))).toBe(true);
      } else {
        // The single stage's active-set signal (`LivePage` gates on this, not `model.live`,
        // which stays non-null through the whole rest period by design — VW-57).
        expect(mapStoreToFatigueModel(src)).not.toBeNull();
      }
    }
  });

  it('keeps an open set on the single stage when the FIRST slot is the one that drops', () => {
    // The surviving limb's set becomes the top-level one, so the fallback renders the arm
    // that is still lifting rather than a blank frame.
    const afterLeftDrops = snapshotWith([slot('right')]);
    expect(selectLiveVariant(afterLeftDrops, null)).toBe('live');
    expect(mapStoreToFatigueModel(sources(afterLeftDrops))).not.toBeNull();
  });

  it('hands the dual stage a bound side the frame the second Voltra binds', () => {
    expect(selectLiveVariant(bilateral, null)).toBe('live-dual');
    expect(hasBoundSide(mapStoreToDivergingHeroModel(sources(bilateral)))).toBe(true);
  });
});

// --- The manual override -----------------------------------------------------

describe('the URL override', () => {
  it('forces DUAL on a rig state that would select single', () => {
    expect(selectLiveVariant(bench, 'live-dual')).toBe('live-dual');
  });

  it('forces SINGLE on a bilateral rig — the only way to pin it there', () => {
    expect(selectLiveVariant(bilateral, 'live')).toBe('live');
  });

  it('reads both spellings off the query string', () => {
    expect(readVariantOverride('?live=1&variant=live-dual')).toBe('live-dual');
    expect(readVariantOverride('?live=1&variant=live')).toBe('live');
  });

  it('is absent when no variant is pinned, so selection comes from state', () => {
    expect(readVariantOverride('?live=1')).toBeNull();
  });

  it('does NOT treat an unrecognized value as an override', () => {
    // A typo must fall through to state, not silently pin the single stage.
    expect(readVariantOverride('?live=1&variant=dual')).toBeNull();
    expect(readVariantOverride('?live=1&variant=')).toBeNull();
  });
});
