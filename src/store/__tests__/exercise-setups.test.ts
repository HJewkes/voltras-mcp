// Tests for the ROM-clustering setup inference and its store writers (VW-119).
//
// Four things here are load-bearing:
//
//   * The split rule is RELATIVE. Every fixture is expressed as a ratio of
//     medians, never as a millimetre distance, so the suite would still be
//     meaningful for a lifter whose cable geometry is nothing like these
//     numbers.
//   * Re-running is a no-op. Setup ids are the FK parent of `sets.setup_id`
//     and carry human labels, so a second pass that renumbered them would move
//     a lifter's name onto a different bench.
//   * A `cluster_version` bump re-clusters, and retires rather than deletes.
//   * `confirmed_at` and the label that came with it survive re-inference.
//     Inference derives membership; it never overrules a human.

import { beforeEach, describe, expect, it } from 'vitest';
import type { Phase } from '@voltras/workout-analytics';

import {
  SETUP_CLUSTER_VERSION,
  SETUP_SPLIT_RATIO,
  clusterSetsByRom,
  inferExerciseSetups,
  nearestClusterIndex,
  setMedianRomM,
  setupLabel,
  setupRowId,
  type SetRomObservation,
} from '../exercise-setups.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../sqlite-store.js';
import type { StoredRep, StoredSet, StoredSide } from '../types.js';

const EMPTY_PHASE: Phase = {
  samples: [],
  startTime: 0,
  endTime: 0,
  startPosition: 0,
  endPosition: 0,
  _totalVelocity: 0,
  _totalForce: 0,
  _totalLoad: 0,
  _movementSampleCount: 0,
  _totalHoldDuration: 0,
  peakVelocity: 0,
  peakForce: 0,
  peakLoad: 0,
};

/**
 * A rep whose concentric travels `romM` metres. `_movementSampleCount` is above
 * the measurable floor so `selectEligibleReps` judges it rather than falling
 * back to "nothing corroborates this".
 */
function makeRep(setId: string, index: number, romM: number): StoredRep {
  const start = index * 3000;
  return {
    repNumber: index + 1,
    concentric: {
      ...EMPTY_PHASE,
      startTime: start,
      endTime: start + 1500,
      endPosition: romM,
      _movementSampleCount: 4,
    },
    eccentric: { ...EMPTY_PHASE, startTime: start + 1500, endTime: start + 3000 },
    id: `${setId}-r${String(index)}`,
    setId,
    index,
  };
}

function obs(setId: string, medianRomM: number): SetRomObservation {
  return { setId, medianRomM };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

/** A working set of five reps, every one at `romM`. */
function makeSet(
  id: string,
  romM: number,
  overrides: Partial<StoredSet> & { sessionId: string },
): StoredSet {
  return {
    id,
    userId: LOCAL_USER_ID,
    exerciseId: 'bench-press',
    startedAt: daysAgo(10 - Number(id.replace(/\D/g, ''))),
    endedAt: daysAgo(10 - Number(id.replace(/\D/g, ''))),
    partial: false,
    reps: Array.from({ length: 5 }, (_, i) => makeRep(id, i, romM)),
    ...overrides,
  };
}

describe('setMedianRomM', () => {
  it('takes the median over the reps that count as work, not every rep', () => {
    // A positioning pull at ~2x the working reps opens the set. It is what
    // `selectEligibleReps` exists to drop, and letting it into the median is
    // how one bench turns into two inferred setups.
    const reps = [makeRep('s', 0, 0.62), makeRep('s', 1, 0.3), makeRep('s', 2, 0.31)];
    expect(setMedianRomM({ reps })).toBeCloseTo(0.305, 5);
  });

  it('is undefined when no rep carries measurable travel', () => {
    expect(setMedianRomM({ reps: [makeRep('s', 0, 0), makeRep('s', 1, 0)] })).toBeUndefined();
  });
});

describe('clusterSetsByRom', () => {
  it('splits two clearly separated ROM groups into two setups', () => {
    const clusters = clusterSetsByRom([
      obs('a', 0.3),
      obs('b', 0.31),
      obs('c', 0.55),
      obs('d', 0.56),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].setIds).toEqual(['a', 'b']);
    expect(clusters[1].setIds).toEqual(['c', 'd']);
    expect(clusters[0].index).toBe(0);
    expect(clusters[1].index).toBe(1);
  });

  it('keeps one ROM group as one setup', () => {
    // THE MUTATION SENTINEL. Break the split rule — drop SETUP_SPLIT_RATIO to
    // 1.0, or swap the relative test for an absolute distance — and these three
    // sets, which differ only by ordinary rep-to-rep variation, become three
    // setups and this expectation fails.
    const clusters = clusterSetsByRom([obs('a', 0.3), obs('b', 0.31), obs('c', 0.305)]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].setIds).toEqual(['a', 'b', 'c']);
  });

  it('joins a set that lands within the ratio of an existing centre', () => {
    const justInside = 0.3 * (SETUP_SPLIT_RATIO - 0.01);
    const clusters = clusterSetsByRom([obs('a', 0.3), obs('b', justInside)]);
    expect(clusters).toHaveLength(1);
  });

  it('opens a new setup for a set just outside the ratio', () => {
    const justOutside = 0.3 * (SETUP_SPLIT_RATIO + 0.01);
    const clusters = clusterSetsByRom([obs('a', 0.3), obs('b', justOutside)]);
    expect(clusters).toHaveLength(2);
  });

  it('assigns to the NEAREST centre, not the first one within the ratio', () => {
    const clusters = clusterSetsByRom([obs('a', 0.3), obs('b', 0.5), obs('c', 0.49)]);
    expect(clusters[1].setIds).toEqual(['b', 'c']);
  });

  it('is append-only: a later set never moves an earlier one', () => {
    const first = clusterSetsByRom([obs('a', 0.3), obs('b', 0.55)]);
    const withMore = clusterSetsByRom([obs('a', 0.3), obs('b', 0.55), obs('c', 0.31)]);
    expect(withMore[0].setIds).toEqual([...first[0].setIds, 'c']);
    expect(withMore[1].setIds).toEqual(first[1].setIds);
  });
});

describe('nearestClusterIndex', () => {
  it('has nothing to join when there are no centres', () => {
    expect(nearestClusterIndex([], 0.3)).toBeUndefined();
  });

  it('treats a non-positive ROM as infinitely far from everything', () => {
    expect(nearestClusterIndex([0.3], 0)).toBeUndefined();
  });
});

describe('setupRowId', () => {
  it('is a total function of the key, the cluster index and the version', () => {
    const key = { userId: LOCAL_USER_ID, exerciseId: 'bench-press', side: 'left' as StoredSide };
    expect(setupRowId(key, 0)).toBe(setupRowId(key, 0));
    expect(setupRowId(key, 0)).not.toBe(setupRowId(key, 1));
    expect(setupRowId(key, 0)).not.toBe(
      setupRowId({ userId: key.userId, exerciseId: key.exerciseId }, 0),
    );
    expect(setupRowId(key, 0)).toContain(SETUP_CLUSTER_VERSION);
  });

  it('percent-encodes ids so a separator in an exercise id cannot collide', () => {
    const a = setupRowId({ userId: 'local', exerciseId: 'a/b' }, 0);
    const b = setupRowId({ userId: 'local', exerciseId: 'a' }, 0);
    expect(a).not.toBe(b);
  });
});

describe('inferExerciseSetups over the store', () => {
  let store: SqliteSessionStore;
  const key = { userId: LOCAL_USER_ID, exerciseId: 'bench-press' };

  async function seed(sets: StoredSet[]): Promise<void> {
    for (const set of sets) await store.putSet(set);
  }

  async function stampedSetupIds(): Promise<(string | undefined)[]> {
    const sets = await store.getSetsForExercise({ ...key, purpose: ['working'] });
    return sets.map((s) => s.setupId);
  }

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    for (const s of ['sess-1', 'sess-2']) await store.putSession({ id: s, startedAt: daysAgo(10) });
  });

  it('writes one setup per ROM group and stamps every set that backs it', async () => {
    await seed([
      makeSet('set-1', 0.3, { sessionId: 'sess-1' }),
      makeSet('set-2', 0.31, { sessionId: 'sess-1' }),
      makeSet('set-3', 0.55, { sessionId: 'sess-2' }),
    ]);

    const summary = await inferExerciseSetups(store, key);

    expect(summary.setups).toHaveLength(2);
    expect(summary.setsStamped).toBe(3);
    expect(summary.clusterVersion).toBe(SETUP_CLUSTER_VERSION);
    // Neutral labels only: inference cannot know the bench height, so it does
    // not name one.
    expect(summary.setups.map((s) => s.label)).toEqual([setupLabel(0), setupLabel(1)]);
    expect(summary.setups.every((s) => !s.confirmed)).toBe(true);

    const [first, second] = summary.setups;
    expect(await stampedSetupIds()).toEqual([first.id, first.id, second.id]);
  });

  it('leaves a set with no measurable ROM unstamped rather than guessing', async () => {
    await seed([
      makeSet('set-1', 0.3, { sessionId: 'sess-1' }),
      makeSet('set-2', 0, { sessionId: 'sess-1' }),
    ]);

    const summary = await inferExerciseSetups(store, key);

    expect(summary.setsStamped).toBe(1);
    expect(await stampedSetupIds()).toEqual([summary.setups[0].id, undefined]);
  });

  it('re-running is a no-op: same ids, same rows, same stamps', async () => {
    await seed([
      makeSet('set-1', 0.3, { sessionId: 'sess-1' }),
      makeSet('set-2', 0.55, { sessionId: 'sess-2' }),
    ]);

    const first = await inferExerciseSetups(store, key);
    const firstStamps = await stampedSetupIds();
    // `detected_at` is when the cluster was FIRST seen, not when the job last
    // ran — a re-run must not restamp the history it is re-deriving.
    const firstDetectedAt = (await store.listExerciseSetups(key)).map((s) => s.detectedAt);

    const second = await inferExerciseSetups(store, key);

    expect(second.setups.map((s) => s.id)).toEqual(first.setups.map((s) => s.id));
    expect(await stampedSetupIds()).toEqual(firstStamps);
    const rows = await store.listExerciseSetups(key);
    expect(rows).toHaveLength(2);
    expect(rows.map((s) => s.detectedAt)).toEqual(firstDetectedAt);
  });

  it('keys left and right separately, never pooling two limbs', async () => {
    await seed([
      makeSet('set-1', 0.3, { sessionId: 'sess-1', side: 'left' }),
      makeSet('set-2', 0.3, { sessionId: 'sess-1', side: 'right' }),
    ]);

    const summary = await inferExerciseSetups(store, key);

    expect(summary.setups).toHaveLength(2);
    expect(summary.setups.map((s) => s.side)).toEqual(['left', 'right']);
  });

  it('re-clusters on a cluster_version bump and retires the superseded row', async () => {
    await seed([makeSet('set-1', 0.3, { sessionId: 'sess-1' })]);
    const stale = 'setup@0.9.0:local/bench-press/both#0';
    await store.putExerciseSetup({
      id: stale,
      userId: LOCAL_USER_ID,
      exerciseId: 'bench-press',
      label: 'setup 1',
      detectedAt: daysAgo(30),
      clusterVersion: 'setup@0.9.0',
    });
    await store.stampSetSetup('set-1', stale);

    const summary = await inferExerciseSetups(store, key);

    expect(summary.setups[0].id).not.toBe(stale);
    expect(await stampedSetupIds()).toEqual([summary.setups[0].id]);
    // Retired, not deleted: it is an FK parent and a human may have named it.
    expect((await store.getExerciseSetup(stale))?.retiredAt).toBeDefined();
    expect((await store.listExerciseSetups(key)).map((s) => s.id)).toEqual([summary.setups[0].id]);
  });

  it('carries a confirmed label and its confirmed_at through re-inference', async () => {
    await seed([makeSet('set-1', 0.3, { sessionId: 'sess-1' })]);
    const first = await inferExerciseSetups(store, key);
    const confirmedAt = daysAgo(1);
    const detected = await store.getExerciseSetup(first.setups[0].id);
    expect(detected).toBeDefined();
    await store.putExerciseSetup({
      ...(detected ?? { id: '', userId: '', exerciseId: '' }),
      label: 'bench at 30 degrees',
      confirmedAt,
    });

    await seed([makeSet('set-2', 0.31, { sessionId: 'sess-1' })]);
    const second = await inferExerciseSetups(store, key);

    expect(second.setups[0].label).toBe('bench at 30 degrees');
    expect(second.setups[0].confirmed).toBe(true);
    expect((await store.getExerciseSetup(first.setups[0].id))?.confirmedAt).toBe(confirmedAt);
  });

  it('ignores warm-ups, matching the corpus the baseline reads', async () => {
    await seed([
      makeSet('set-1', 0.3, { sessionId: 'sess-1' }),
      makeSet('set-2', 0.55, { sessionId: 'sess-1', setPurpose: 'warmup' }),
    ]);

    const summary = await inferExerciseSetups(store, key);

    expect(summary.setups).toHaveLength(1);
    expect(summary.setsStamped).toBe(1);
  });

  it('never stamps a guest lifter’s set into the owner’s setups', async () => {
    await seed([
      makeSet('set-1', 0.3, { sessionId: 'sess-1' }),
      makeSet('set-2', 0.55, { sessionId: 'sess-1', lifter: 'Jordan' }),
    ]);

    const summary = await inferExerciseSetups(store, key);

    expect(summary.setups).toHaveLength(1);
    expect((await store.getSet('set-2'))?.setupId).toBeUndefined();
  });

  it('preserves the stamp across a re-put of the same set row', async () => {
    // `putSet` does not list `setup_id`, so a force-end followed by an explicit
    // re-end must not clear what the clustering wrote.
    const set = makeSet('set-1', 0.3, { sessionId: 'sess-1' });
    await seed([set]);
    const summary = await inferExerciseSetups(store, key);

    await store.putSet({ ...set, partial: true, partialReason: 'disconnect' });

    expect((await store.getSet('set-1'))?.setupId).toBe(summary.setups[0].id);
  });
});

describe('setup-keyed baselines', () => {
  let store: SqliteSessionStore;
  const key = { userId: LOCAL_USER_ID, exerciseId: 'bench-press' };

  beforeEach(async () => {
    store = SqliteSessionStore.open(':memory:');
    await store.putSession({ id: 'sess-1', startedAt: daysAgo(10) });
  });

  it('rejects a key naming a setup that no clustering run produced', async () => {
    await expect(store.getBaseline({ ...key, setupId: 'setup-a' })).rejects.toThrow(
      /unknown setup/,
    );
    await expect(store.recalcBaseline({ ...key, setupId: 'setup-a' })).rejects.toThrow(
      /unknown setup/,
    );
  });

  it('derives a baseline that reads only the sets stamped into its setup', async () => {
    for (const [id, rom] of [
      ['set-1', 0.3],
      ['set-2', 0.31],
      ['set-3', 0.305],
      ['set-4', 0.55],
    ] as const) {
      await store.putSet(makeSet(id, rom, { sessionId: 'sess-1' }));
    }
    const summary = await inferExerciseSetups(store, key);
    const [wide, narrow] = summary.setups;

    const wideBaseline = await store.recalcBaseline({ ...key, setupId: wide.id });
    const narrowBaseline = await store.recalcBaseline({ ...key, setupId: narrow.id });

    expect(wideBaseline.setupId).toBe(wide.id);
    expect(wideBaseline.id).not.toBe(narrowBaseline.id);
    // Three sets back the first setup, one backs the second — so only the
    // first clears the shape floor.
    expect(wideBaseline.state).toBe('SHAPE_ONLY');
    expect(narrowBaseline.state).toBe('COLD');
  });
});
