// Set-level risk score that gates intra-set cues (VW-152 section 3). Pure: no store, no device, no clock.

import { DEFAULT_SET_RISK_THRESHOLDS, type SetRiskThresholds } from './set-risk-constants.js';

export type RiskLevel = 0 | 1 | 2;
export type ExerciseRiskClass = 'isolation' | 'supported_compound' | 'loaded_compound';
export type RiskBand = 'green' | 'amber' | 'red';
export type RiskVeto =
  | 'missing_signal'
  | 'non_constant_mode'
  | 'guest_lifter'
  | 'heavy_loaded_compound';

export interface SetRiskInputs {
  readonly exerciseClass: ExerciseRiskClass | null;
  readonly relativeIntensity: number | null;
  readonly loadLbs: number | null;
  readonly setIndexInExercise: number | null;
  readonly priorSetDecayed: boolean | null;
  readonly resistanceFamily: 'constant' | 'other' | null;
  readonly guestLifter: boolean;
}

export interface SetRiskFactors {
  readonly exercise: RiskLevel | null;
  readonly intensity: RiskLevel | null;
  readonly load: RiskLevel | null;
  readonly fatigue: RiskLevel | null;
}

export interface SetRiskReading {
  readonly band: RiskBand;
  readonly points: number;
  readonly factors: SetRiskFactors;
  readonly vetoes: readonly RiskVeto[];
  readonly permitsIntraSet: boolean;
}

const MAX_LEVEL: RiskLevel = 2;

const EXERCISE_LEVEL: Readonly<Record<ExerciseRiskClass, RiskLevel>> = {
  isolation: 0,
  supported_compound: 1,
  loaded_compound: 2,
};

function levelFromEdges(value: number, moderate: number, high: number): RiskLevel {
  if (value >= high) return 2;
  return value >= moderate ? 1 : 0;
}

export function intensityLevel(
  relativeIntensity: number | null,
  t: SetRiskThresholds,
): RiskLevel | null {
  if (relativeIntensity === null || !Number.isFinite(relativeIntensity)) return null;
  return levelFromEdges(relativeIntensity, t.intensityModerate, t.intensityHigh);
}

export function loadLevel(loadLbs: number | null, t: SetRiskThresholds): RiskLevel | null {
  if (loadLbs === null || !Number.isFinite(loadLbs)) return null;
  if (t.loadModerateLbs === null || t.loadHighLbs === null) return MAX_LEVEL;
  return levelFromEdges(loadLbs, t.loadModerateLbs, t.loadHighLbs);
}

export function fatigueLevel(
  setIndex: number | null,
  priorSetDecayed: boolean | null,
  t: SetRiskThresholds,
): RiskLevel | null {
  if (setIndex === null || !Number.isFinite(setIndex)) return null;
  const decayed = setIndex <= 1 ? (priorSetDecayed ?? false) : priorSetDecayed;
  if (decayed === null) return null;
  const indexLevel = setIndex >= t.lateSetFromIndex ? 1 : 0;
  return Math.min(MAX_LEVEL, indexLevel + (decayed ? 1 : 0)) as RiskLevel;
}

function scoreFactors(inputs: SetRiskInputs, t: SetRiskThresholds): SetRiskFactors {
  return {
    exercise: inputs.exerciseClass === null ? null : EXERCISE_LEVEL[inputs.exerciseClass],
    intensity: intensityLevel(inputs.relativeIntensity, t),
    load: loadLevel(inputs.loadLbs, t),
    fatigue: fatigueLevel(inputs.setIndexInExercise, inputs.priorSetDecayed, t),
  };
}

// A missing factor counts at its maximum so an unknown never scores below a known value.
function sumPoints(factors: SetRiskFactors): number {
  return Object.values(factors).reduce<number>((sum, level) => sum + (level ?? MAX_LEVEL), 0);
}

function collectVetoes(inputs: SetRiskInputs, factors: SetRiskFactors): RiskVeto[] {
  const vetoes: RiskVeto[] = [];
  const anyFactorMissing = Object.values(factors).some((level) => level === null);
  if (anyFactorMissing || inputs.resistanceFamily === null) vetoes.push('missing_signal');
  if (inputs.resistanceFamily === 'other') vetoes.push('non_constant_mode');
  if (inputs.guestLifter) vetoes.push('guest_lifter');
  if (factors.exercise === 2 && factors.intensity === 2) vetoes.push('heavy_loaded_compound');
  return vetoes;
}

function bandFor(points: number, vetoes: readonly RiskVeto[], t: SetRiskThresholds): RiskBand {
  if (vetoes.length > 0 || points > t.amberMax) return 'red';
  return points > t.greenMax ? 'amber' : 'green';
}

export function scoreSetRisk(
  inputs: SetRiskInputs,
  thresholds: SetRiskThresholds = DEFAULT_SET_RISK_THRESHOLDS,
): SetRiskReading {
  const factors = scoreFactors(inputs, thresholds);
  const points = sumPoints(factors);
  const vetoes = collectVetoes(inputs, factors);
  const band = bandFor(points, vetoes, thresholds);
  return { band, points, factors, vetoes, permitsIntraSet: band === 'green' };
}
