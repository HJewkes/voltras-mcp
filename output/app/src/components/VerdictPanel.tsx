import type { ExerciseSummary, Tone, VerdictState } from "../types";
import { absentVerdictReason } from "../derive";
import { ToneGlyph } from "./ToneGlyph";

export const STATE_LABEL: Record<VerdictState, string> = {
  good: "Good",
  slowing: "Slowing",
  grinding: "Grinding",
  "form-breakdown": "Form breaking down",
};

const DIMENSIONS = [
  { key: "velocityLoss", label: "VEL", name: "Velocity loss" },
  { key: "rom", label: "ROM", name: "Range of motion" },
  { key: "tempo", label: "TEMPO", name: "Tempo" },
] as const;

export function VerdictPanel({ exercise }: { exercise: ExerciseSummary }) {
  const { verdict } = exercise;
  if (!verdict) return <NoVerdict exercise={exercise} />;
  return (
    <div className={`verdict tone-${verdict.tone}`}>
      <div className="kicker">
        How it moved · worst set #{exercise.verdictSetIndex}
        {exercise.maxVelocityLossPct !== null && <span className="nowrap"> · VL {exercise.maxVelocityLossPct}%</span>}
      </div>
      <div className="verdict__state">
        <ToneGlyph tone={verdict.tone} />
        <span>{STATE_LABEL[verdict.state]}</span>
      </div>
      <ul className="dims" aria-label="Verdict dimensions">
        {DIMENSIONS.map((d) => (
          <DimensionChip key={d.key} label={d.label} name={d.name} tone={verdict.dimensions[d.key]} />
        ))}
      </ul>
      <PartialTelemetryNote exercise={exercise} />
    </div>
  );
}

/** A verdict that could only read some working sets says which ones it could not. */
function PartialTelemetryNote({ exercise }: { exercise: ExerciseSummary }) {
  const blind = exercise.sets.filter((s) => s.setPurpose === "working" && s.velocityLossPct === null);
  if (blind.length === 0) return null;
  const list = blind.map((s) => `#${s.index}`).join(", ");
  return (
    <p className="verdict__partial">
      Read {exercise.workingSetCount - blind.length} of {exercise.workingSetCount} working sets: {list} had no telemetry.
    </p>
  );
}

function DimensionChip({ label, name, tone }: { label: string; name: string; tone: Tone }) {
  return (
    <li className={`dim tone-${tone}`} title={`${name}: ${tone}`}>
      <ToneGlyph tone={tone} />
      <span>{label}</span>
    </li>
  );
}

function NoVerdict({ exercise }: { exercise: ExerciseSummary }) {
  const { title, reason } = absentVerdictReason(exercise);
  return (
    <div className="verdict tone-none">
      <div className="kicker">How it moved</div>
      <div className="verdict__state verdict__state--none">
        <ToneGlyph tone="none" />
        <span>{title}</span>
      </div>
      <p className="verdict__why">{reason}</p>
    </div>
  );
}
