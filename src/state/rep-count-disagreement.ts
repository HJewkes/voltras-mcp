// One set can produce several rep counts that do not agree (VMCP-02.59: a
// single bench set read live 12, analytics 13, device total 14, device set
// summary 12). This module makes that split VISIBLE and nothing else.
//
// The device counts reps; this server only enriches them. So nothing here
// picks a winner, averages, `max()`es, or rewrites a count from another one —
// the disagreement is the signal, and reconciling it would erase exactly the
// evidence a reader needs.

/**
 * Name of one rep count, chosen to match the key it already appears under on
 * the `set_ended` payload so a reader can map a report line back to a number
 * they can see.
 */
export type RepCountSourceName =
  | 'analytics_reps'
  | 'device_total'
  | 'device_set_summary'
  | 'device_summary';

/** Plain-language provenance for each count, for a reader who has never read this codebase. */
const SOURCE_PROVENANCE: Record<RepCountSourceName, string> = {
  analytics_reps:
    'reps this server segmented out of the telemetry stream itself (the `reps` array)',
  device_total:
    "the device's own running rep total for the set, recorded verbatim and never adjusted",
  device_set_summary: "the count on the device's end-of-set summary, exactly as it arrived",
  device_summary: "the count on the device's end-of-workout summary, exactly as it arrived",
};

/** Report order: derived first, then the device's counts from most to least aggregated. */
const SOURCE_ORDER: RepCountSourceName[] = [
  'analytics_reps',
  'device_total',
  'device_set_summary',
  'device_summary',
];

/** One count, with where it came from. */
export interface RepCountReading {
  source: RepCountSourceName;
  count: number;
  provenance: string;
}

/** Two counts that disagree, and by how much. Never says which is right. */
export interface RepCountDelta {
  between: [RepCountSourceName, RepCountSourceName];
  /** Absolute size of the gap, always at least 1 — agreeing pairs are not listed. */
  difference: number;
}

export interface RepCountDisagreement {
  /** Every count that exists for this set, including the ones that agree with each other. */
  counts: RepCountReading[];
  /** Every pair that disagrees. A pair that agrees is omitted, not reported as 0. */
  deltas: RepCountDelta[];
  /**
   * Always `null`. Calling a gap large or small needs a tolerance, and no
   * source in this repo states one. A single rep is the interesting case —
   * VMCP-02.23 and VMCP-02.42 are both about an over-count of exactly one on a
   * cable-engagement rep — so suppressing small gaps would hide the reports
   * worth reading. The numbers are reported; the reader judges.
   */
  verdict: null;
}

/**
 * The counts a set can carry. Each one is optional because each one is
 * genuinely absent on some sets: `device_set_summary` and `device_summary`
 * only exist while the frames that carried them are in hand, and nothing
 * persists them.
 *
 * An absent source stays absent. It is NEVER read as `0` — "the device sent no
 * count" and "the device counted no reps" are different claims about the set,
 * and a fabricated zero makes them indistinguishable.
 */
export interface RepCountSources {
  analytics_reps?: number | undefined;
  device_total?: number | undefined;
  device_set_summary?: number | undefined;
  device_summary?: number | undefined;
}

/**
 * Derive the disagreement report for one set, or `undefined` when there is
 * nothing to report — fewer than two counts exist, or every count that exists
 * agrees. A set whose counts agree gets no report at all rather than an empty
 * "0 disagreement" object on every close.
 *
 * Derived at read time from the counts themselves on every call, so it cannot
 * drift away from what it describes. Nothing here is stored.
 */
export function deriveRepCountDisagreement(
  sources: RepCountSources,
): RepCountDisagreement | undefined {
  const counts: RepCountReading[] = SOURCE_ORDER.flatMap((source) => {
    const count = sources[source];
    return count === undefined ? [] : [{ source, count, provenance: SOURCE_PROVENANCE[source] }];
  });
  const deltas = pairwiseDeltas(counts);
  if (deltas.length === 0) {
    return undefined;
  }
  return { counts, deltas, verdict: null };
}

/** Every pair of counts whose values differ, in report order. */
function pairwiseDeltas(counts: RepCountReading[]): RepCountDelta[] {
  const deltas: RepCountDelta[] = [];
  for (let i = 0; i < counts.length; i += 1) {
    for (let j = i + 1; j < counts.length; j += 1) {
      const a = counts[i];
      const b = counts[j];
      if (a === undefined || b === undefined || a.count === b.count) continue;
      deltas.push({
        between: [a.source, b.source],
        difference: Math.abs(a.count - b.count),
      });
    }
  }
  return deltas;
}
