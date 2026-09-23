import { describe, expect, it } from 'vitest';

import { buildContext } from '../context.js';
import { buildRetroData, RETRO_DATA_KEYS } from '../data.js';

import { mapEntry, syntheticLog } from './fixtures.js';

function data() {
  const { rows, checkins } = syntheticLog();
  const json = JSON.stringify(
    buildRetroData(buildContext(rows, checkins, [mapEntry()], null), '2030-03-01'),
  );
  return JSON.parse(json) as Record<string, unknown>;
}

describe('buildRetroData', () => {
  it('carries every top-level key the page builder reads, in order', () => {
    expect(Object.keys(data())).toEqual([...RETRO_DATA_KEYS]);
  });

  it('keeps per-session numbers unrounded with sets and total reps', () => {
    const lifts = data().lifts as {
      sessions: { e1rm: number; sets: number; totalReps: number }[];
    }[];
    expect(lifts[0]!.sessions).toHaveLength(12);
    expect(lifts[0]!.sessions[0]).toMatchObject({
      sets: 3,
      totalReps: 15,
      e1rm: 100 * (1 + 5 / 30),
    });
  });

  it('lists one block row per judged block with prescription and done counts', () => {
    const blocks = (data().misses as { blocks: Record<string, unknown>[] }).blocks;
    expect(blocks).toHaveLength(12);
    expect(blocks[0]).toMatchObject({
      prescribedSets: 3,
      prescribedReps: 5,
      doneSets: 3,
      minReps: 5,
      missed: false,
    });
  });
});
