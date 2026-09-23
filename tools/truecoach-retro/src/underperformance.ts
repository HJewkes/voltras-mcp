// The two-session underperformance proxy: RP's MRV hit, read from missed targets instead of velocity.

import type { TargetVerdict } from '../../../src/analytics/target-verdict.js';

/** One judged block, attributed to one muscle. */
export interface MuscleVerdict {
  muscle: string;
  date: string;
  verdict: TargetVerdict;
}

/** Consecutive judged sessions on one muscle that all underperformed. */
export interface UnderperformanceRun {
  muscle: string;
  startDate: string;
  endDate: string;
  sessions: number;
  /** The run's session dates; every one from the second on is a flagged session. */
  dates: string[];
}

/** Per muscle, per date: did any block miss. Dates with no judged block are left out. */
function sessionsByMuscle(verdicts: readonly MuscleVerdict[]): Map<string, Map<string, boolean>> {
  const byMuscle = new Map<string, Map<string, boolean>>();
  for (const { muscle, date, verdict } of verdicts) {
    if (verdict === 'no-target') continue;
    const sessions = byMuscle.get(muscle) ?? new Map<string, boolean>();
    sessions.set(date, (sessions.get(date) ?? false) || verdict === 'miss');
    byMuscle.set(muscle, sessions);
  }
  return byMuscle;
}

function runsOf(
  muscle: string,
  sessions: Map<string, boolean>,
  minSessions: number,
): UnderperformanceRun[] {
  const runs: UnderperformanceRun[] = [];
  let current: string[] = [];
  const close = () => {
    if (current.length >= minSessions) {
      runs.push({
        muscle,
        startDate: current[0]!,
        endDate: current.at(-1)!,
        sessions: current.length,
        dates: current,
      });
    }
    current = [];
  };
  for (const date of [...sessions.keys()].sort()) {
    if (sessions.get(date)) current.push(date);
    else close();
  }
  close();
  return runs;
}

/**
 * Runs of `minSessions` or more consecutive sessions on one muscle that each missed a target.
 * Sessions, not weeks: RP's example is a Monday then a Thursday.
 */
export function underperformanceRuns(
  verdicts: readonly MuscleVerdict[],
  minSessions = 2,
): UnderperformanceRun[] {
  return [...sessionsByMuscle(verdicts)].flatMap(([muscle, sessions]) =>
    runsOf(muscle, sessions, minSessions),
  );
}
