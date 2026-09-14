// `readDietPhaseState`'s `isDietPhase` guard (VW-363).
//
// The guard exists so a phase string this build's vocabulary does not
// recognize degrades to `'unknown'` rather than throwing or being trusted
// verbatim — the shape a rolled-back build hits reading a `recomposition` row
// written by a newer one. These fixtures pin that degrade path generically
// (an arbitrary unrecognized string) and confirm the current build now reads
// `recomposition` itself rather than degrading it.

import { describe, expect, it, vi } from 'vitest';

import { readDietPhaseState, UNKNOWN_DIET_PHASE_STATE } from '../diet-phase-state.js';
import type { ServerState } from '../../state/server-state.js';
import type { StoredDietPhase } from '../../store/types.js';

function stateCoveredBy(phase: string): ServerState {
  const row: StoredDietPhase = {
    id: 'row-1',
    userId: 'local',
    phase,
    startedAt: '2026-01-01T00:00:00.000Z',
    declaredAt: '2026-01-01T00:00:00.000Z',
  };
  const store = { getDietPhaseCovering: vi.fn(async () => row) };
  return { store } as unknown as ServerState;
}

describe('readDietPhaseState — the isDietPhase guard', () => {
  it('degrades a phase string the build does not recognize to unknown, not a throw', async () => {
    const state = stateCoveredBy('a-future-phase-this-build-has-never-heard-of');

    await expect(readDietPhaseState(state, '2026-02-01T00:00:00.000Z')).resolves.toEqual(
      UNKNOWN_DIET_PHASE_STATE,
    );
  });

  it('now reads a recomposition row as its own phase, not unknown', async () => {
    const state = stateCoveredBy('recomposition');

    const result = await readDietPhaseState(state, '2026-02-01T00:00:00.000Z');

    expect(result.phase).toBe('recomposition');
    expect(result.weeksInPhase).not.toBeNull();
  });
});
