export type Tone = 'ok' | 'warn' | 'alarm'
export type VerdictState = 'good' | 'slowing' | 'grinding' | 'form-breakdown'
export type SetPurpose = 'working' | 'warmup' | 'probe' | 'technique'
export type Unit = 'lb' | 'kg'

export interface Verdict {
  state: VerdictState
  tone: Tone
  dimensions: { velocityLoss: Tone; rom: Tone; tempo: Tone }
}

export interface ExpectedRepRange {
  expectedLow: number
  expectedHigh: number
  median: number
  n: number
  basis: string
}

export interface SessionSet {
  id: string
  index: number
  startedAt: string
  endedAt: string
  weightLbs: number | null
  loadLabel: string
  repCount: number
  setPurpose: SetPurpose
  velocityLossPct: number | null
  bestRepVelocity: number | null
  expectedRepRange: ExpectedRepRange | null
}

export interface Progression {
  delta: number
  reasoning: string
  basedOnSessionId: string
  targetSets: number
  targetRepsLow: number
  targetRepsHigh: number
  targetWeightLbs: number
}

export interface LoadDrift {
  programmedPct: number
  impliedPct: number
  deltaPct: number
  reason: string
}

export interface ExerciseSummary {
  exerciseId: string | null
  name: string
  setCount: number
  workingSetCount: number
  totalReps: number
  volumeLbs: number | null
  topWeightLbs: number | null
  bestRepVelocity: number | null
  maxVelocityLossPct: number | null
  verdict: Verdict | null
  verdictSetIndex: number | null
  sets: SessionSet[]
  progression: Progression | null
  progressionNote: string | null
  loadDrift: LoadDrift | null
}

export interface SessionSummary {
  session: {
    id: string
    startedAt: string
    endedAt: string | null
    exerciseId: string | null
    exerciseName: string | null
  }
  exercises: ExerciseSummary[]
}
