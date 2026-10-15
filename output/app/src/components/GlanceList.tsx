import type { ExerciseSummary, Units } from "../types";
import { absentVerdictReason } from "../derive";
import { formatLoad } from "../units";
import { ToneGlyph } from "./ToneGlyph";
import { STATE_LABEL } from "./VerdictPanel";

const ARROW = { 5: "↑", 0: "=", [-5]: "↓" } as const;

/** Phone only: the whole session's verdicts and next loads in one thumb-length list. */
export function GlanceList({ exercises, units }: { exercises: ExerciseSummary[]; units: Units }) {
  return (
    <ol className="glance" aria-label="Session at a glance">
      {exercises.map((e) => (
        <li key={e.exerciseId ?? e.name} className={`glance__item tone-${e.verdict?.tone ?? "none"}`}>
          <a href={`#ex-${e.exerciseId ?? "unattributed"}`}>
            <ToneGlyph tone={e.verdict?.tone ?? "none"} />
            <span className="glance__name">{e.name}</span>
            <span className="glance__state">{e.verdict ? STATE_LABEL[e.verdict.state] : absentVerdictReason(e).title}</span>
            <span className="glance__next num">
              {e.progression ? `${ARROW[e.progression.delta]} ${formatLoad(e.progression.targetWeightLbs, units)}` : "—"}
            </span>
          </a>
        </li>
      ))}
    </ol>
  );
}
