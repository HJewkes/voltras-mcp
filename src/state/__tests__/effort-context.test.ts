// The pure effort-context builder (VW-540): each goal source, each loss source,
// the pull gate, the resistance and the profile rule. Every value is synthetic.

import { describe, expect, it } from 'vitest';

import { RIR_VELOCITY_MODEL_VERSION, type RirVelocityModel } from '../../analytics/rir-velocity.js';
import type { ResolvedWatchConfig } from '../../schemas/set.js';
import type { StoredPlannedExercise } from '../../store/types.js';
import {
  buildEffortContext,
  profileToPin,
  settingsSignature,
  type EffortContextInputs,
  type EffortProfile,
} from '../effort-context.js';
import type { DeviceSnapshot } from '../live-state.js';
import { hashSettingsContext, readSettingsContext } from '../set-capture.js';

const DEVICE: DeviceSnapshot = { connected: true, weightLbs: 100, trainingMode: 'Weight Training' };

const PROFILE: EffortProfile = {
  interceptMps: 0.2,
  slopeMpsPerRir: 0.05,
  rirErrorReps: 1,
  rirRange: [0, 5],
  intensityRange: [0.6, 0.85],
  resistanceFamily: 'constant',
  modelVersion: RIR_VELOCITY_MODEL_VERSION,
};

function planned(fields: Partial<StoredPlannedExercise>): StoredPlannedExercise {
  return {
    id: 'pe-1',
    workoutTemplateId: 'tpl-1',
    exerciseId: 'ex-1',
    orderIndex: 0,
    targetSets: 3,
    ...fields,
  };
}

function watch(...notifyOn: ResolvedWatchConfig['notifyOn']): ResolvedWatchConfig {
  return { notifyOn };
}

function inputs(overrides: Partial<EffortContextInputs> = {}): EffortContextInputs {
  return {
    set: {},
    device: DEVICE,
    planned: undefined,
    profile: 'no_model',
    ...overrides,
  };
}

describe('the pinned goal', () => {
  it.each([
    {
      scenario: 'a planned rep range with an RPE is a rep range, the RPE its cap',
      planned: planned({
        goalKind: 'rep_range',
        targetRepsLow: 8,
        targetRepsHigh: 10,
        targetRpe: 8,
      }),
      watch: undefined,
      goal: { kind: 'rep_range', repsLow: 8, repsHigh: 10, source: 'plan' },
    },
    {
      scenario: 'a planned RPE goal keeps the row reps as its fallback',
      planned: planned({ goalKind: 'target_rpe', targetRpe: 8, targetRepsLow: 6 }),
      watch: undefined,
      goal: { kind: 'target_rpe', targetRpe: 8, repsLow: 6, repsHigh: 6, source: 'plan' },
    },
    {
      scenario: 'a planned loss percent',
      planned: planned({ goalKind: 'velocity_loss', targetVelocityLossPct: 25 }),
      watch: undefined,
      goal: { kind: 'velocity_loss', lossPct: 25, source: 'plan' },
    },
    {
      scenario: 'a planned loss goal stated by intent only',
      planned: planned({ goalKind: 'velocity_loss', trainingIntent: 'strength' }),
      watch: undefined,
      goal: { kind: 'velocity_loss', lossPct: 20, source: 'plan_intent' },
    },
    {
      scenario: 'a typed rep count',
      planned: undefined,
      watch: watch({ type: 'rep_count_reached', value: 8 }),
      goal: { kind: 'rep_range', repsLow: 8, repsHigh: 8, source: 'explicit' },
    },
    {
      scenario: 'a typed loss with nothing else',
      planned: undefined,
      watch: watch({ type: 'velocity_loss_exceeded', pct: 30, thresholdSource: 'set_intent' }),
      goal: { kind: 'velocity_loss', lossPct: 30, source: 'set_intent' },
    },
    {
      scenario: 'a row with no goal kind and no watch',
      planned: planned({ targetRepsLow: 8 }),
      watch: undefined,
      goal: null,
    },
  ])('$scenario', ({ planned: row, watch: w, goal }) => {
    const context = buildEffortContext(inputs({ planned: row, set: { watch: w } }));

    expect(context.goal).toEqual(goal);
  });

  it('prefers the plan over a typed watch, and keeps the typed loss as the guard', () => {
    const context = buildEffortContext(
      inputs({
        planned: planned({ goalKind: 'rep_range', targetRepsLow: 5 }),
        set: {
          watch: watch({ type: 'velocity_loss_exceeded', pct: 15, thresholdSource: 'explicit' }),
        },
      }),
    );

    expect(context.goal).toMatchObject({ kind: 'rep_range', source: 'plan' });
    expect(context.guard).toMatchObject({ lossPct: 15, lossSource: 'explicit' });
  });

  it('makes a typed rep count the goal and a typed loss the guard when both are typed', () => {
    const context = buildEffortContext(
      inputs({
        set: {
          watch: watch(
            { type: 'rep_count_reached', value: 10 },
            { type: 'velocity_loss_exceeded', pct: 20, thresholdSource: 'explicit' },
          ),
        },
      }),
    );

    expect(context.goal).toMatchObject({ kind: 'rep_range', repsLow: 10 });
    expect(context.guard).toMatchObject({ lossPct: 20, lossSource: 'explicit' });
  });
});

describe('the pinned guard', () => {
  it.each([
    { thresholdSource: 'explicit' as const },
    { thresholdSource: 'set_intent' as const },
    { thresholdSource: 'plan_intent' as const },
  ])('carries a watch loss resolved from $thresholdSource exactly', ({ thresholdSource }) => {
    const context = buildEffortContext(
      inputs({
        set: {
          watch: watch(
            { type: 'rep_count_reached', value: 8 },
            { type: 'velocity_loss_exceeded', pct: 20, thresholdSource },
          ),
        },
      }),
    );

    expect(context.guard).toMatchObject({ lossPct: 20, lossSource: thresholdSource });
  });

  it('takes the plan intent loss when no watch names one', () => {
    const context = buildEffortContext(
      inputs({
        planned: planned({ goalKind: 'rep_range', targetRepsLow: 8, trainingIntent: 'power' }),
      }),
    );

    expect(context.guard).toMatchObject({ lossPct: 10, lossSource: 'plan_intent' });
  });

  // The wall's fallback (hypertrophy, 30) colours bands; it must never become a guard.
  it('guards with no loss when nothing resolved one, and bands on the named default', () => {
    const context = buildEffortContext(inputs());

    expect(context.guard).toEqual({
      effortCapRpe: null,
      effortCapSource: null,
      lossPct: null,
      lossSource: null,
    });
    expect(context.bandReferenceLossPct).toBe(30);
  });

  it('caps effort at the row RPE, and leaves the default cap to the library policy', () => {
    const withRpe = buildEffortContext(
      inputs({ planned: planned({ goalKind: 'rep_range', targetRepsLow: 8, targetRpe: 8.5 }) }),
    );
    const withoutRpe = buildEffortContext(
      inputs({ planned: planned({ goalKind: 'rep_range', targetRepsLow: 8 }) }),
    );

    expect(withRpe.guard).toMatchObject({ effortCapRpe: 8.5, effortCapSource: 'plan' });
    expect(withoutRpe.guard).toMatchObject({ effortCapRpe: null, effortCapSource: null });
  });

  it('bands on the loss goal before the guard', () => {
    const context = buildEffortContext(
      inputs({ planned: planned({ goalKind: 'velocity_loss', targetVelocityLossPct: 35 }) }),
    );

    expect(context.bandReferenceLossPct).toBe(35);
    expect(context.guard.lossPct).toBeNull();
  });
});

describe('the pinned signal, resistance and profile', () => {
  it.each([
    { force: undefined, valid: false },
    { force: true, valid: true },
  ])('a pull with force $force has a valid velocity signal: $valid', ({ force }) => {
    const set = {
      movementClass: 'pull' as const,
      watch: { notifyOn: [], ...(force !== undefined ? { velocityLoss: { force } } : {}) },
    };

    const context = buildEffortContext(inputs({ set }));

    expect(context.velocitySignalValid).toBe(force === true);
  });

  it('signs the resistance with the stored settings hash, never a setting value', () => {
    const device: DeviceSnapshot = { ...DEVICE, chainSettingLbs: 20 };

    const context = buildEffortContext(inputs({ device }));

    expect(context.resistance).toEqual({
      family: 'chains',
      signature: hashSettingsContext(readSettingsContext(device)),
    });
    expect(JSON.stringify(context.resistance)).not.toContain('20');
  });

  it('signs an unrecorded settings context with a fixed placeholder', () => {
    expect(settingsSignature(DEVICE)).toBe('none');
  });

  it('pins a profile with its relative intensity, and keeps the withheld reason otherwise', () => {
    const trusted = buildEffortContext(
      inputs({ profile: { profile: PROFILE, relativeIntensity: 0.7 } }),
    );
    const withheld = buildEffortContext(inputs({ profile: 'stale' }));

    expect(trusted).toMatchObject({
      profile: PROFILE,
      relativeIntensity: 0.7,
      profileWithheld: null,
    });
    expect(withheld).toMatchObject({
      profile: null,
      relativeIntensity: null,
      profileWithheld: 'stale',
    });
  });
});

describe('profileToPin', () => {
  const NOW = new Date('2026-09-21T12:00:00.000Z');
  const MODEL: RirVelocityModel = {
    form: 'linear',
    version: RIR_VELOCITY_MODEL_VERSION,
    resistanceFamily: 'constant',
    interceptMps: 0.2,
    slopeMpsPerRir: 0.05,
    r2: 0.9,
    seeMps: 0.05,
    rirErrorReps: 1,
    pointCount: 30,
    setCount: 6,
    sessionCount: 3,
    rirRange: [0, 5],
    intensityRange: [0.6, 0.85],
    anchorSources: { failure: 2, selfReport: 4 },
    observedFrom: '2026-09-01T12:00:00.000Z',
    observedTo: '2026-09-20T12:00:00.000Z',
    heldOutErrorReps: 1,
  };

  it('pins a trusted curve fitted under the set family', () => {
    expect(profileToPin(MODEL, 'constant', NOW)).toEqual(PROFILE);
  });

  it.each([
    { scenario: 'no curve', model: undefined, family: 'constant' as const, reason: 'no_model' },
    {
      scenario: 'a failed trust gate',
      model: { ...MODEL, rirErrorReps: 1.6 },
      family: 'constant' as const,
      reason: 'fit_error',
    },
    {
      scenario: 'a set of another family',
      model: MODEL,
      family: 'chains' as const,
      reason: 'family_mismatch',
    },
  ])('withholds for $scenario', ({ model, family, reason }) => {
    expect(profileToPin(model, family, NOW)).toBe(reason);
  });
});
