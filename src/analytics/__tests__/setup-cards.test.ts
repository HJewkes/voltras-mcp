// The declared setup card (VW-275): comparability against the exercise's
// reference card, and the digest-seeded default when nothing is confirmed.

import { describe, it, expect } from 'vitest';

import {
  compareSetupCards,
  getReferenceSetupCard,
  seededReferenceCard,
  type ReferenceSetupCardCatalog,
  type ReferenceSetupCardStore,
} from '../setup-cards.js';
import type { SetupCard, StoredExerciseSetup } from '../../store/types.js';

function card(overrides: Partial<SetupCard> = {}): SetupCard {
  return { anchor: 'mid', ...overrides };
}

describe('compareSetupCards', () => {
  it('calls a session comparable when its card matches the reference exactly', () => {
    const verdict = compareSetupCards(
      card({ mountHole: 3, mode: 'Normal' }),
      card({ mountHole: 3, mode: 'Normal' }),
    );

    expect(verdict.comparability).toBe('comparable');
  });

  it('flags a mismatched anchor', () => {
    const verdict = compareSetupCards(card({ anchor: 'low' }), card({ anchor: 'high' }));

    expect(verdict.comparability).toBe('setup_card_mismatch');
    expect(verdict.reason).toContain('anchor');
  });

  it('flags a mismatched mount hole', () => {
    const verdict = compareSetupCards(card({ mountHole: 2 }), card({ mountHole: 5 }));

    expect(verdict.comparability).toBe('setup_card_mismatch');
    expect(verdict.reason).toContain('mountHole');
  });

  it('flags a mismatched cable-length setting even across string/number', () => {
    const verdict = compareSetupCards(
      card({ cableLengthSetting: 36 }),
      card({ cableLengthSetting: '48 in' }),
    );

    expect(verdict.comparability).toBe('setup_card_mismatch');
    expect(verdict.reason).toContain('cableLengthSetting');
  });

  it('does not flag a field recorded on only one side', () => {
    const verdict = compareSetupCards(card({ mountHole: 3 }), card());

    expect(verdict.comparability).toBe('comparable');
  });

  it('reports setup_card_unverified, not a mismatch, when the session has no card', () => {
    const verdict = compareSetupCards(undefined, card());

    expect(verdict.comparability).toBe('setup_card_unverified');
    expect(verdict.reference).toEqual(card());
    expect(verdict.session).toBeUndefined();
  });

  it('reports setup_card_unverified when neither side has a card', () => {
    const verdict = compareSetupCards(undefined, undefined);

    expect(verdict.comparability).toBe('setup_card_unverified');
  });
});

describe('seededReferenceCard', () => {
  it('maps a low cablePath to a low anchor', () => {
    expect(seededReferenceCard({ cableSetup: { cablePath: 'low', attachments: [] } })).toEqual({
      anchor: 'low',
    });
  });

  it('buckets floor into low — the setup card has no distinct floor landmark', () => {
    expect(seededReferenceCard({ cableSetup: { cablePath: 'floor', attachments: [] } })).toEqual({
      anchor: 'low',
    });
  });

  it('leaves multiple (barbell/Twin patterns) unmapped', () => {
    expect(
      seededReferenceCard({ cableSetup: { cablePath: 'multiple', attachments: [] } }),
    ).toBeUndefined();
  });

  it('returns undefined for an exercise with no cable setup at all', () => {
    expect(seededReferenceCard({})).toBeUndefined();
  });
});

function setupRow(overrides: Partial<StoredExerciseSetup> = {}): StoredExerciseSetup {
  return {
    id: 'setup@1.0.0:u/e/both#0',
    userId: 'u',
    exerciseId: 'e',
    detectedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('getReferenceSetupCard', () => {
  const key = { userId: 'u', exerciseId: 'e' };

  it('prefers the most recently confirmed card over the seeded default', async () => {
    const store: ReferenceSetupCardStore = {
      listExerciseSetups: async () => [
        setupRow({ confirmedAt: '2026-01-01T00:00:00.000Z', card: card({ anchor: 'low' }) }),
        setupRow({ confirmedAt: '2026-02-01T00:00:00.000Z', card: card({ anchor: 'high' }) }),
      ],
    };
    const catalog: ReferenceSetupCardCatalog = {
      getById: () => ({ cableSetup: { cablePath: 'mid', attachments: [] } }),
    };

    await expect(getReferenceSetupCard(store, catalog, key)).resolves.toEqual({ anchor: 'high' });
  });

  it('falls back to the digest-seeded default when nothing is confirmed', async () => {
    const store: ReferenceSetupCardStore = { listExerciseSetups: async () => [] };
    const catalog: ReferenceSetupCardCatalog = {
      getById: () => ({ cableSetup: { cablePath: 'high', attachments: [] } }),
    };

    await expect(getReferenceSetupCard(store, catalog, key)).resolves.toEqual({ anchor: 'high' });
  });

  it('ignores a confirmed setup with no card', async () => {
    const store: ReferenceSetupCardStore = {
      listExerciseSetups: async () => [setupRow({ confirmedAt: '2026-01-01T00:00:00.000Z' })],
    };
    const catalog: ReferenceSetupCardCatalog = {
      getById: () => ({ cableSetup: { cablePath: 'low', attachments: [] } }),
    };

    await expect(getReferenceSetupCard(store, catalog, key)).resolves.toEqual({ anchor: 'low' });
  });

  it('returns undefined when there is no confirmed card and no catalog entry', async () => {
    const store: ReferenceSetupCardStore = { listExerciseSetups: async () => [] };
    const catalog: ReferenceSetupCardCatalog = { getById: () => undefined };

    await expect(getReferenceSetupCard(store, catalog, key)).resolves.toBeUndefined();
  });
});
