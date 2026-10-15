// The delivery ledger records each set's risk reading and why an intra-set line was refused (VW-615).

import { describe, expect, it } from 'vitest';

import {
  scoreSetRisk,
  type SetRiskInputs,
  type SetRiskReading,
} from '../../../analytics/set-risk.js';
import { DEFAULT_SET_RISK_THRESHOLDS } from '../../../analytics/set-risk-constants.js';
import type { CuesMidSetMode } from '../../../config.js';
import { makeCueSettings } from '../../cue-settings.js';
import { CueSelector } from '../../cue-templates.js';
import { DeliveryEmitter, type DeliveryRecord } from '../delivery-emitter.js';
import { riskIntraSetPermit, type SetRiskReadingFor } from '../risk-permit.js';
import { reps, slowdown, started, STEADY_REPS } from './delivery-fixtures.js';

const SET_ID = 'set-risk';
const THRESHOLDS = { ...DEFAULT_SET_RISK_THRESHOLDS, loadModerateLbs: 40, loadHighLbs: 100 };

const LIGHT_CURL: SetRiskInputs = {
  exerciseClass: 'isolation',
  relativeIntensity: 0.6,
  loadLbs: 25,
  setIndexInExercise: 1,
  priorSetDecayed: false,
  resistanceFamily: 'constant',
  guestLifter: false,
};
const HEAVY_CHEST_PRESS: SetRiskInputs = {
  ...LIGHT_CURL,
  exerciseClass: 'supported_compound',
  relativeIntensity: 0.9,
  loadLbs: 80,
};
const LATE_HEAVY_SQUAT: SetRiskInputs = {
  ...LIGHT_CURL,
  exerciseClass: 'loaded_compound',
  relativeIntensity: 0.8,
  loadLbs: 120,
  setIndexInExercise: 5,
};

const score = (inputs: SetRiskInputs): SetRiskReading => scoreSetRisk(inputs, THRESHOLDS);

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Lift one set whose third rep raises a slowdown, and return every budget decision recorded. */
async function liftOneSet(
  mode: CuesMidSetMode,
  pinned: SetRiskReading | undefined,
): Promise<DeliveryRecord[]> {
  const readingFor: SetRiskReadingFor = (_slot, setId) => (setId === SET_ID ? pinned : undefined);
  return liftWith(mode, readingFor);
}

async function liftWith(
  mode: CuesMidSetMode,
  readingFor: SetRiskReadingFor,
): Promise<DeliveryRecord[]> {
  const records: DeliveryRecord[] = [];
  const emitter = new DeliveryEmitter({
    speak: () => Promise.resolve(),
    platform: 'darwin',
    clock: () => 1_000,
    settings: makeCueSettings({ cues: 'on', cuesMidSet: mode }),
    selector: new CueSelector({ rng: () => 0 }),
    tierFor: () => Promise.resolve('beginner'),
    exerciseFor: () => 'row',
    repsFor: () => STEADY_REPS,
    intraSetPermit: riskIntraSetPermit(readingFor),
    setRiskFor: ({ slot, setId }) => readingFor(slot, setId),
    onDecision: (record) => records.push(record),
  });
  for (const event of [started(SET_ID), ...reps(SET_ID, 2)]) {
    emitter.onEvent(event);
    await settle();
  }
  for (const event of [...reps(SET_ID, 1, 3), slowdown(SET_ID, 3)]) emitter.onEvent(event);
  await settle();
  return records;
}

const intraLines = (records: DeliveryRecord[]): DeliveryRecord[] =>
  records.filter((record) => record.interval === 'intra');

describe('the cue ledger under VMCP_CUES_MIDSET=risk', () => {
  it('records band, points and factor levels on a green set and admits the intra-set line', async () => {
    // Act
    const records = await liftOneSet('risk', score(LIGHT_CURL));

    // Assert
    const green = {
      band: 'green',
      points: 0,
      factors: { exercise: 0, intensity: 0, load: 0, fatigue: 0 },
      vetoes: [],
    };
    expect(records.length).toBeGreaterThan(1);
    expect(records.map((record) => record.risk)).toEqual(records.map(() => green));
    expect(intraLines(records).map((record) => record.decision)).toEqual([
      { admit: true, reason: 'within_budget' },
    ]);
  });

  it('refuses the intra-set line on an amber set with risk_band_amber', async () => {
    // Act
    const records = await liftOneSet('risk', score(HEAVY_CHEST_PRESS));

    // Assert
    expect(intraLines(records)).toMatchObject([
      {
        decision: { admit: false, reason: 'risk_band_amber' },
        risk: {
          band: 'amber',
          points: 4,
          factors: { exercise: 1, intensity: 2, load: 1, fatigue: 0 },
          vetoes: [],
        },
      },
    ]);
  });

  it('refuses the intra-set line on a red set with risk_band_red', async () => {
    // Act
    const records = await liftOneSet('risk', score(LATE_HEAVY_SQUAT));

    // Assert
    expect(intraLines(records)).toMatchObject([
      {
        decision: { admit: false, reason: 'risk_band_red' },
        risk: {
          band: 'red',
          points: 6,
          factors: { exercise: 2, intensity: 1, load: 2, fatigue: 1 },
          vetoes: [],
        },
      },
    ]);
  });

  it('records the typed veto ids of a vetoed set', async () => {
    // Act
    const records = await liftOneSet('risk', score({ ...LIGHT_CURL, guestLifter: true }));

    // Assert
    expect(intraLines(records)).toMatchObject([
      {
        decision: { admit: false, reason: 'risk_band_red' },
        risk: { band: 'red', points: 0, vetoes: ['guest_lifter'] },
      },
    ]);
  });

  it('records a null reading and risk_reading_missing when no reading is pinned', async () => {
    // Act
    const records = await liftOneSet('risk', undefined);

    // Assert
    expect(records.every((record) => record.risk === null)).toBe(true);
    expect(intraLines(records).map((record) => record.decision)).toEqual([
      { admit: false, reason: 'risk_reading_missing' },
    ]);
  });

  it('records no reading when the lookup throws, and refuses with risk_reading_missing', async () => {
    // Act
    const records = await liftWith('risk', () => {
      throw new Error('live state unavailable');
    });

    // Assert
    expect(intraLines(records)).toMatchObject([
      { decision: { admit: false, reason: 'risk_reading_missing' }, risk: null },
    ]);
  });
});

describe.each<CuesMidSetMode>(['off', 'on'])('the cue ledger under %s', (mode) => {
  it('carries no risk field, whatever reading is pinned', async () => {
    // Act
    const records = await liftOneSet(mode, score(LATE_HEAVY_SQUAT));

    // Assert
    expect(records.length).toBeGreaterThan(1);
    expect(records.some((record) => 'risk' in record)).toBe(false);
    expect(intraLines(records).map((record) => record.decision.reason)).toEqual([
      mode === 'on' ? 'within_budget' : 'midset_disabled',
    ]);
  });
});
