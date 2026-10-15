import type { ExerciseSummary, Tone, Units } from '../types';
import {
  TONE_WORD,
  VERDICT_LABEL,
  formatDelta,
  formatLoad,
  noVerdictReason,
  strengthSummary,
} from '../derive';
import { FatigueChart } from './FatigueChart';
import { DeltaIcon, FlagIcon, ToneIcon } from './Icons';

interface Props {
  exercise: ExerciseSummary;
  units: Units;
  scaleMax: number;
}

const DIMENSIONS = [
  { key: 'velocityLoss', label: 'Speed' },
  { key: 'rom', label: 'Range' },
  { key: 'tempo', label: 'Tempo' },
] as const;

function Dimension({ label, tone }: { label: string; tone: Tone }) {
  return (
    <li className={`dim tone-${tone}`}>
      <ToneIcon tone={tone} size={16} />
      <span>{label}</span>
      <span className="sr-only">{TONE_WORD[tone]}</span>
    </li>
  );
}

function VerdictPanel({ exercise }: { exercise: ExerciseSummary }) {
  const { verdict } = exercise;
  const verdictSet = exercise.sets.find((s) => s.index === exercise.verdictSetIndex);
  return (
    <div className="panel panel--verdict">
      <h2 className="ex-name">{exercise.name}</h2>
      {verdict ? (
        <>
          <p className={`verdict tone-${verdict.tone}${verdict.state === 'form-breakdown' ? ' verdict--long' : ''}`}>
            <ToneIcon tone={verdict.tone} size={36} />
            <span>{VERDICT_LABEL[verdict.state]}</span>
          </p>
          <ul className="dims" aria-label="Verdict dimensions">
            {DIMENSIONS.map((d) => (
              <Dimension key={d.key} label={d.label} tone={verdict.dimensions[d.key]} />
            ))}
          </ul>
          <p className="meta">
            Hardest set #{exercise.verdictSetIndex}
            {verdictSet?.velocityLossPct != null && ` · ${verdictSet.velocityLossPct}% speed loss`}
          </p>
        </>
      ) : (
        <>
          <p className="verdict verdict--none">No verdict</p>
          <p className="meta">{noVerdictReason(exercise)}</p>
        </>
      )}
    </div>
  );
}

function StrengthStat({ exercise, units }: Props) {
  const strength = strengthSummary(exercise);
  if (!strength) {
    return (
      <div className="strength strength--none">
        <span className="label">Est. max</span>
        <span className="strength-missing">needs a recorded load</span>
      </div>
    );
  }
  const { best, changePct } = strength;
  const change =
    changePct === null ? 'one working set' : `${changePct > 0 ? '+' : changePct < 0 ? '−' : '±'}${Math.abs(changePct).toFixed(0)}% first → last set`;
  return (
    <div className="strength">
      <span className="label">Est. max · session best</span>
      <span className="strength-value num">{formatLoad(best.e1rm, units)}</span>
      <span className="meta num">
        set #{best.set.index} · {change}
      </span>
    </div>
  );
}

function EvidencePanel(props: Props) {
  return (
    <div className="panel panel--evidence">
      <div className="evidence-head">
        <span className="label">Fatigue · velocity loss per set</span>
      </div>
      <div className="evidence-body">
        <FatigueChart exercise={props.exercise} scaleMax={props.scaleMax} />
        <StrengthStat {...props} />
      </div>
    </div>
  );
}

const DELTA_WORD = { 5: 'Add', 0: 'Hold', [-5]: 'Back off' } as const;

function targetLine(exercise: ExerciseSummary, units: Units): string | null {
  const p = exercise.progression;
  if (!p) return null;
  const reps =
    p.targetRepsLow !== null && p.targetRepsHigh !== null ? `${p.targetRepsLow}–${p.targetRepsHigh}` : null;
  const load = p.targetWeightLbs !== null ? formatLoad(p.targetWeightLbs, units) : null;
  const scheme = reps ? `${p.targetSets} × ${reps}` : `${p.targetSets} sets`;
  return load ? `${load} · ${scheme}` : scheme;
}

function LoadDriftNote({ exercise }: { exercise: ExerciseSummary }) {
  const drift = exercise.loadDrift;
  if (!drift) return null;
  const direction = drift.deltaPct < 0 ? 'got easier' : 'got harder';
  return (
    <p className="drift" title={drift.reason}>
      <FlagIcon size={18} />
      <span>
        Load {direction}: <span className="num">{drift.programmedPct}% → {drift.impliedPct}%</span> of max
      </span>
    </p>
  );
}

function NextPanel({ exercise, units }: Props) {
  const p = exercise.progression;
  return (
    <div className="panel panel--next">
      <span className="label">Next time</span>
      {p ? (
        <>
          <p className={`next-headline delta-${Math.sign(p.delta)}`}>
            <DeltaIcon delta={p.delta} size={30} />
            <span>
              {DELTA_WORD[p.delta]}
              {p.delta !== 0 && ` ${formatDelta(p.delta, units)}`}
            </span>
          </p>
          <p className="next-target num">{targetLine(exercise, units)}</p>
          <p className="meta">{p.reasoning}</p>
        </>
      ) : (
        <>
          <p className="next-headline next-headline--none">No recommendation</p>
          <p className="meta">{exercise.progressionNote ?? 'No progression for this exercise.'}</p>
        </>
      )}
      <LoadDriftNote exercise={exercise} />
    </div>
  );
}

export function ExerciseRow(props: Props) {
  const tone = props.exercise.verdict?.tone ?? 'none';
  return (
    <article className={`ex-row edge-${tone}`}>
      <VerdictPanel exercise={props.exercise} />
      <EvidencePanel {...props} />
      <NextPanel {...props} />
    </article>
  );
}
