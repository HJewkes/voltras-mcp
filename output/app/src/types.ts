// Mirrors the session-summary payload contract exactly.

export type Tone = 'ok' | 'warn' | 'alarm';
export type VerdictState = 'good' | 'slowing' | 'grinding' | 'form-breakdown';
export type SetPurpose = 'working' | 'warmup' | 'probe' | 'technique';

export interface Verdict {
  state: VerdictState;
  tone: Tone;
  dimensions: { velocityLoss: Tone; rom: Tone; tempo: Tone };
}

export interface Progression {
  delta: 5 | 0 | -5;
  reasoning: string;
  targetSets: number;
  targetRepsLow: number | null;
  targetRepsHigh: number | null;
  targetWeightLbs: number | null;
}

export interface LoadDrift {
  programmedPct: number;
  impliedPct: number;
  deltaPct: number;
  reason: string;
}

export interface ExpectedRepRange {
  expectedLow: number;
  expectedHigh: number;
  median: number;
  n: number;
  basis: string;
}

export interface SessionSet {
  index: number;
  startedAt: string;
  endedAt: string;
  weightLbs: number | null;
  loadLabel: string | null;
  repCount: number;
  setPurpose: SetPurpose;
  velocityLossPct: number | null;
  bestRepVelocity: number | null;
  expectedRepRange: ExpectedRepRange | null;
}

export interface ExerciseSummary {
  name: string;
  setCount: number;
  workingSetCount: number;
  totalReps: number;
  volumeLbs: number | null;
  topWeightLbs: number | null;
  bestRepVelocity: number | null;
  maxVelocityLossPct: number | null;
  verdict: Verdict | null;
  verdictSetIndex: number | null;
  progression: Progression | null;
  progressionNote: string | null;
  loadDrift: LoadDrift | null;
  sets: SessionSet[];
}

export interface SessionSummary {
  session: {
    id: string;
    startedAt: string;
    endedAt: string | null;
    exerciseName: string | null;
  };
  exercises: ExerciseSummary[];
}

export type Units = 'lb' | 'kg';
