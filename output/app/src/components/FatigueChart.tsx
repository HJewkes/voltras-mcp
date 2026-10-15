import type { ExerciseSummary, SessionSet, Tone } from '../types';
import { VL_BAND_LABEL, vlBand } from '../derive';

const THRESHOLDS = [
  { pct: 10, label: 'VL10' },
  { pct: 20, label: 'VL20' },
  { pct: 30, label: 'VL30' },
];

const PURPOSE_SHORT: Record<SessionSet['setPurpose'], string | null> = {
  working: null,
  warmup: 'warm',
  probe: 'probe',
  technique: 'tech',
};

interface Props {
  exercise: ExerciseSummary;
  scaleMax: number;
}

function barClass(set: SessionSet, verdictSetIndex: number | null, tone: Tone | undefined): string {
  if (set.setPurpose !== 'working') return 'vl-bar vl-bar--aux';
  if (set.index === verdictSetIndex && tone) return `vl-bar vl-bar--verdict tone-${tone}`;
  return 'vl-bar';
}

function describe(set: SessionSet): string {
  if (set.velocityLossPct === null) return `Set ${set.index}: no velocity telemetry`;
  const band = VL_BAND_LABEL[vlBand(set.velocityLossPct)];
  return `Set ${set.index} (${set.setPurpose}): ${set.velocityLossPct}% velocity loss, ${band}`;
}

function Bar({ set, exercise, scaleMax }: { set: SessionSet; exercise: ExerciseSummary; scaleMax: number }) {
  const isVerdict = set.index === exercise.verdictSetIndex;
  const purpose = PURPOSE_SHORT[set.setPurpose];
  return (
    <div className="vl-col" title={describe(set)}>
      <div className="vl-stack">
        {set.velocityLossPct === null ? (
          <span className="vl-none">no data</span>
        ) : (
          <>
            <span className={`vl-value${isVerdict ? ' vl-value--verdict' : ''}`}>{set.velocityLossPct}%</span>
            <div
              className={barClass(set, exercise.verdictSetIndex, exercise.verdict?.tone)}
              style={{ height: `${(Math.min(set.velocityLossPct, scaleMax) / scaleMax) * 100}%` }}
            />
          </>
        )}
      </div>
      <span className="vl-tick">
        #{set.index}
        {purpose && <em>{purpose}</em>}
      </span>
    </div>
  );
}

export function FatigueChart({ exercise, scaleMax }: Props) {
  const summary = exercise.sets.map(describe).join('; ');
  return (
    <figure className="vl-chart" aria-label={`Velocity loss per set. ${summary}`}>
      <div className="vl-plot">
        <div className="vl-refs" aria-hidden>
          {THRESHOLDS.filter((t) => t.pct < scaleMax).map((t) => (
            <div key={t.pct} className="vl-ref" style={{ bottom: `${(t.pct / scaleMax) * 100}%` }}>
              <span>{t.label}</span>
            </div>
          ))}
        </div>
        <div className="vl-bars">
          {exercise.sets.map((s) => (
            <Bar key={s.index} set={s} exercise={exercise} scaleMax={scaleMax} />
          ))}
        </div>
      </div>
    </figure>
  );
}
