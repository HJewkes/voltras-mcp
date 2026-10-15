import type { ExerciseSummary, SessionSet, SessionSummary } from "./types";

/** Epley. Only meaningful for a set with a real load and at least one rep. */
export function estimatedOneRepMax(set: SessionSet): number | null {
  if (set.weightLbs === null || set.repCount < 1) return null;
  return set.weightLbs * (1 + set.repCount / 30);
}

export function bestE1rmSetIndex(exercise: ExerciseSummary): number | null {
  let best: { index: number; value: number } | null = null;
  for (const set of exercise.sets) {
    if (set.setPurpose !== "working") continue;
    const value = estimatedOneRepMax(set);
    if (value !== null && (best === null || value > best.value)) best = { index: set.index, value };
  }
  return best?.index ?? null;
}

export function restBeforeSeconds(sets: SessionSet[], position: number): number | null {
  if (position === 0) return null;
  const gap = Date.parse(sets[position].startedAt) - Date.parse(sets[position - 1].endedAt);
  return Math.round(gap / 1000);
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const dayFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

export const formatDay = (iso: string) => dayFormat.format(new Date(iso));
export const formatTime = (iso: string) => timeFormat.format(new Date(iso));

export interface SessionTotals {
  setCount: number;
  workingSetCount: number;
  totalReps: number;
  volumeLbs: number | null;
  unloadedExercises: string[];
  minutes: number | null;
  lastSetEndedAt: string | null;
}

export function sessionTotals({ session, exercises }: SessionSummary): SessionTotals {
  const loaded = exercises.filter((e) => e.volumeLbs !== null);
  const allSets = exercises.flatMap((e) => e.sets);
  const lastEnd = allSets.map((s) => s.endedAt).sort().at(-1) ?? null;
  return {
    setCount: sum(exercises.map((e) => e.setCount)),
    workingSetCount: sum(exercises.map((e) => e.workingSetCount)),
    totalReps: sum(exercises.map((e) => e.totalReps)),
    volumeLbs: loaded.length ? sum(loaded.map((e) => e.volumeLbs ?? 0)) : null,
    unloadedExercises: exercises.filter((e) => e.volumeLbs === null).map((e) => e.name),
    minutes: session.endedAt
      ? Math.round((Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 60000)
      : null,
    lastSetEndedAt: lastEnd,
  };
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export interface AbsentVerdict {
  title: string;
  reason: string;
}

export function absentVerdictReason(exercise: ExerciseSummary): AbsentVerdict {
  if (exercise.workingSetCount === 0) {
    const purposes = [...new Set(exercise.sets.map((s) => s.setPurpose))].join(" and ");
    return { title: "Not scored", reason: `Only ${purposes} sets. Verdicts read working sets.` };
  }
  const working = exercise.sets.filter((s) => s.setPurpose === "working");
  if (working.every((s) => s.velocityLossPct === null)) {
    return { title: "No bar-speed data", reason: "No velocity telemetry on any working set." };
  }
  return { title: "No verdict", reason: "The server returned no verdict for these sets." };
}

/** Working sets the rep target can score: a load is needed to plan a load. */
export function scoredWorkingSets(exercise: ExerciseSummary): SessionSet[] {
  return exercise.sets.filter((s) => s.setPurpose === "working" && s.weightLbs !== null);
}

export interface SignalComparison {
  kind: "agree" | "differ";
  headline: string;
  detail: string;
}

/**
 * The verdict reads bar quality on the worst working set; progression reads reps
 * against the plan. When they point in opposite directions we say so in words.
 */
export function compareSignals(exercise: ExerciseSummary): SignalComparison | null {
  const { verdict, progression } = exercise;
  if (!verdict || !progression) return null;
  const scored = scoredWorkingSets(exercise);
  const missed = scored.filter((s) => s.repCount < progression.targetRepsLow).length;
  const target = `${progression.targetRepsLow}–${progression.targetRepsHigh}`;
  if (progression.delta < 0 && verdict.tone === "ok") {
    return {
      kind: "differ",
      headline: "Moved well, but missed reps",
      detail: `Speed, range and tempo held, yet ${missed} of ${scored.length} sets fell short of ${target} reps.`,
    };
  }
  if (progression.delta > 0 && verdict.tone !== "ok") {
    return {
      kind: "differ",
      headline: "Hit the reps, but the bar slowed",
      detail: `Reps reached the ${target} target while set ${exercise.verdictSetIndex} read ${verdict.state}.`,
    };
  }
  return { kind: "agree", headline: "Speed and reps agree", detail: "" };
}
