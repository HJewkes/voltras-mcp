// Prescription parser: fixed sets x reps with an optional load, from the coach's raw text.

/** What one block was prescribed. `repsLow` is null for AMRAP; `loadLbs` null when unstated. */
export interface PrescriptionTarget {
  sets: number;
  repsLow: number | null;
  loadLbs: number | null;
}

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const REPS = String.raw`(\d+)(?:\s*-\s*\d+)?`;
const LOAD_FIRST = new RegExp(String.raw`^${NUMBER}\s*@\s*(\d+)\s*x\s*${REPS}\b`, 'i');
const SETS_FIRST = new RegExp(String.raw`^(\d+)\s*x\s*${REPS}(?:\s|$|RPE|@)`, 'i');
const AMRAP = /^(\d+)\s*x\s*AMRAP\b/i;

/** One line's target, or `null` when the line is not a fixed sets x reps shape (a circuit heading, prose). */
export function parsePrescriptionLine(line: string): PrescriptionTarget | null {
  const text = line.trim();
  const loadFirst = LOAD_FIRST.exec(text);
  if (loadFirst) {
    return {
      loadLbs: Number(loadFirst[1]),
      sets: Number(loadFirst[2]),
      repsLow: Number(loadFirst[3]),
    };
  }
  const amrap = AMRAP.exec(text);
  if (amrap) return { sets: Number(amrap[1]), repsLow: null, loadLbs: null };
  const setsFirst = SETS_FIRST.exec(text);
  if (setsFirst)
    return { sets: Number(setsFirst[1]), repsLow: Number(setsFirst[2]), loadLbs: null };
  return null;
}

/**
 * A block's combined target: sets add up, the rep floor is the lowest line's, and the load is
 * the lightest stated one. `null` when there is no line or any line is not a fixed shape.
 */
export function blockTarget(lines: readonly string[]): PrescriptionTarget | null {
  if (lines.length === 0) return null;
  const targets = lines.map(parsePrescriptionLine);
  if (targets.some((target) => target === null)) return null;
  const parsed = targets as PrescriptionTarget[];
  const floors = parsed.map((target) => target.repsLow);
  const loads = parsed.map((target) => target.loadLbs);
  return {
    sets: parsed.reduce((sum, target) => sum + target.sets, 0),
    repsLow: floors.some((floor) => floor === null) ? null : Math.min(...(floors as number[])),
    loadLbs: loads.every((load) => load !== null) ? Math.min(...(loads as number[])) : null,
  };
}
