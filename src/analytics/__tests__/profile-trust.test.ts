// When a fitted curve may drive the effort cue (VW-448 design s.3.4, VW-538).

import { describe, expect, it } from 'vitest';

import {
  HELD_OUT_MAX_ERROR_REPS,
  isTrustedRirModel,
  profileTrust,
  RIR_VELOCITY_MODEL_VERSION,
  TRUSTED_RIR_ERROR_REPS,
  type RirVelocityModel,
} from '../rir-velocity.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');

/** A curve that passes every gate. Each case below breaks exactly one. */
const TRUSTED: RirVelocityModel = {
  form: 'linear',
  version: RIR_VELOCITY_MODEL_VERSION,
  resistanceFamily: 'constant',
  interceptMps: 0.2,
  slopeMpsPerRir: 0.05,
  r2: 0.95,
  seeMps: 0.03,
  rirErrorReps: 0.6,
  pointCount: 24,
  setCount: 4,
  sessionCount: 4,
  rirRange: [0, 5],
  intensityRange: [0.75, 0.85],
  anchorSources: { failure: 1, selfReport: 3 },
  observedFrom: '2026-08-20T10:00:00.000Z',
  observedTo: '2026-09-14T10:00:00.000Z',
  heldOutErrorReps: 0.8,
};

describe('profileTrust', () => {
  it('trusts a curve that passes every gate', () => {
    expect(profileTrust(TRUSTED, NOW)).toEqual({ trusted: true, reason: null });
  });

  it.each<[string, Partial<RirVelocityModel>, string]>([
    [
      'a curve fitted under an older model version',
      { version: 'rir-velocity@1.1.0' },
      'stale_model_version',
    ],
    [
      'a fit error just past the bound',
      { rirErrorReps: TRUSTED_RIR_ERROR_REPS + 0.01 },
      'fit_error',
    ],
    ['no failure anchor', { anchorSources: { failure: 0, selfReport: 4 } }, 'no_failure_anchor'],
    ['no held-out figure', { heldOutErrorReps: null }, 'held_out_miss'],
    [
      'a held-out miss past the bound',
      { heldOutErrorReps: HELD_OUT_MAX_ERROR_REPS + 0.01 },
      'held_out_miss',
    ],
    ['a newest set older than 42 days', { observedTo: '2026-08-09T11:59:59.000Z' }, 'stale'],
    ['a curve fitted on chains sets', { resistanceFamily: 'chains' }, 'not_constant_load'],
  ])('refuses %s', (_name, change, reason) => {
    expect(profileTrust({ ...TRUSTED, ...change }, NOW)).toEqual({ trusted: false, reason });
  });

  it('keeps the edges of the held-out and freshness gates inside', () => {
    const edge = {
      ...TRUSTED,
      heldOutErrorReps: HELD_OUT_MAX_ERROR_REPS,
      observedTo: '2026-08-10T12:00:00.000Z',
    };

    expect(profileTrust(edge, NOW).trusted).toBe(true);
  });

  it('reads the same fit-error bound isTrustedRirModel reads: 1.5 or under', () => {
    const atBound = { ...TRUSTED, rirErrorReps: 1.5 };
    const justOver = { ...TRUSTED, rirErrorReps: 1.51 };

    expect(TRUSTED_RIR_ERROR_REPS).toBe(1.5);
    expect([isTrustedRirModel(atBound), profileTrust(atBound, NOW).trusted]).toEqual([true, true]);
    expect([isTrustedRirModel(justOver), profileTrust(justOver, NOW).reason]).toEqual([
      false,
      'fit_error',
    ]);
  });
});
