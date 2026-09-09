// `exercise_setups` — inferring the PHYSICAL configuration a set was performed
// at, by clustering median concentric ROM (VW-119).
//
// WHAT A SETUP IS
// ---------------
// Bench height, cable attachment, stance, seat position: the things that change
// how far the handle travels without changing the exercise. It is deliberately
// NOT the device settings context (`chains_lbs`, `damper_level`, the
// `settings_hash`) — that is readable config the device reports, this is
// physical geometry nobody records. Conflating the two breaks like-vs-like
// matching in both directions.
//
// A setup is INFERRED, never declared, because nothing in the product asks the
// lifter to describe their bench. The only observable that moves with geometry
// is how far the cable travels, so that is what is clustered.
//
// THE SPLIT RULE IS RELATIVE, NEVER ABSOLUTE
// ------------------------------------------
// Same stance as `state/rep-eligibility.ts`: nothing here knows what a row
// "should" measure, so a set is judged only against the other sets for its own
// (user, exercise, side) key, as a RATIO of medians. An absolute millimetre
// threshold would encode one lifter's cable geometry as a constant and be wrong
// for everyone else.
//
// LABELS ARE NEUTRAL. Inference produces "setup 1", "setup 2" — an ordering,
// not a claim. It cannot know the bench was at 30 degrees, so it does not say
// so. Only `exercise.confirm_setup` writes a name a human chose, and that name
// (and its `confirmed_at`) survives every later re-inference.

import { getRepRangeOfMotion, type Rep } from '@voltras/workout-analytics';

import { selectEligibleReps } from '../state/rep-eligibility.js';
import type { ExerciseSetupStore, StoredExerciseSetup, StoredSet, StoredSide } from './types.js';

/**
 * Stamped onto every row this module writes, and part of every setup id. Bump
 * on ANY change to the split rule or the assignment order below: cluster
 * membership is only interpretable against the rules that produced it, and a
 * bump is what makes a re-cluster distinguishable from a re-run.
 *
 * A bump re-clusters. Rows at a superseded version are RETIRED rather than
 * deleted (`retired_at`), because a human may have named one and that name is
 * evidence about a physical setup that still exists.
 */
export const SETUP_CLUSTER_VERSION = 'setup@1.0.0';

/**
 * A set whose median eligible-rep ROM is off every existing cluster centre by
 * more than this multiple (or less than its reciprocal) opens a new setup.
 *
 * RELATIVE AND SYMMETRIC, on the `ROM_OUTLIER_RATIO` precedent in
 * `state/rep-eligibility.ts`: the same "judged only against its own peers,
 * never against an absolute distance" rule, applied one level up — set medians
 * against cluster centres rather than rep ROMs against a set median.
 *
 * The VALUE is lower than that rule's 1.8 because it answers a different
 * question. 1.8 separates a positioning pull from real work inside ONE set,
 * where the two differ by roughly double. Here the question is whether two real
 * working sets happened at the same bench, and the protocol's own figure for
 * "the geometry changed" is a sustained 10-15 % move in median concentric ROM
 * (vbt-rir-research-and-protocol.md §4.5, quoted in `exercise-baselines.ts`'s
 * `staleAfterDays` note). 1.15 is the top of that band: below it, two sets are
 * the same setup performed with ordinary rep-to-rep variation.
 */
export const SETUP_SPLIT_RATIO = 1.15;

/** One set reduced to the single number the clustering reads. */
export interface SetRomObservation {
  setId: string;
  medianRomM: number;
}

/** One inferred cluster: an ordinal, its centre, and the sets that landed in it. */
export interface SetupCluster {
  /** Position in creation order. Load-bearing — it is part of the setup id. */
  index: number;
  /** Median of the member sets' median ROMs, in metres. */
  centreRomM: number;
  setIds: string[];
}

/** Identity of one clustering run: the dimensions a setup is per. */
export interface SetupClusterKey {
  userId: string;
  exerciseId: string;
  /**
   * Absent means the side was never resolved. Its own bucket, NEVER merged into
   * `left` or `right`: pooling an unknown-side set with a known-side one
   * compares two limbs' geometry and manufactures a split that is really an
   * asymmetry.
   */
  side?: StoredSide;
}

/** One setup as the inference run reports it back. */
export interface InferredSetup {
  id: string;
  label: string;
  side?: StoredSide;
  centreRomM: number;
  setCount: number;
  /** A human named this setup via `exercise.confirm_setup`. */
  confirmed: boolean;
}

/** What one `inferExerciseSetups` pass did. */
export interface SetupInferenceSummary {
  exerciseId: string;
  clusterVersion: string;
  setups: InferredSetup[];
  setsStamped: number;
}

/**
 * The single number one set contributes to the clustering: the median ROM over
 * the reps that count as work.
 *
 * `selectEligibleReps` FIRST, deliberately. The positioning pull that opens a
 * cable set runs roughly double a working rep, and letting it into the median
 * would move a set's ROM enough to fabricate a second setup out of one bench.
 *
 * `undefined` when no rep carries a measurable travel — such a set is not
 * evidence about geometry and is left unstamped rather than dragged to zero.
 */
export function setMedianRomM(set: Pick<StoredSet, 'reps'>): number | undefined {
  const roms = selectEligibleReps(set.reps)
    .map((rep: Rep) => getRepRangeOfMotion(rep))
    .filter((rom) => rom > 0);
  return roms.length === 0 ? undefined : median(roms);
}

/**
 * Cluster set medians into setups, in ONE pass over `observations` in the order
 * given (chronological, as `getSetsForExercise` returns them).
 *
 * ONLINE AND APPEND-ONLY, which is what makes the whole job idempotent: each
 * observation joins the nearest existing centre within
 * {@link SETUP_SPLIT_RATIO} or opens the next cluster, and a later observation
 * never moves an earlier one. So re-running over a corpus that gained one set
 * reproduces every previous assignment and appends — which in turn means the
 * `set.end` hook (assign the just-closed set to the nearest cluster or open a
 * new one) and the batch re-run are the SAME algorithm, not two that have to be
 * kept agreeing.
 *
 * The centre is the MEDIAN of its members, not a running mean: one deep rep-set
 * that scraped in at the ratio boundary must not drag the centre far enough to
 * admit the next one.
 */
export function clusterSetsByRom(observations: readonly SetRomObservation[]): SetupCluster[] {
  const clusters: SetupCluster[] = [];
  const members: number[][] = [];
  for (const obs of observations) {
    const index = nearestClusterIndex(
      clusters.map((c) => c.centreRomM),
      obs.medianRomM,
    );
    if (index === undefined) {
      clusters.push({ index: clusters.length, centreRomM: obs.medianRomM, setIds: [obs.setId] });
      members.push([obs.medianRomM]);
      continue;
    }
    clusters[index].setIds.push(obs.setId);
    members[index].push(obs.medianRomM);
    clusters[index].centreRomM = median(members[index]);
  }
  return clusters;
}

/**
 * Index of the centre `romM` is closest to in ratio terms, or `undefined` when
 * even the closest is further than {@link SETUP_SPLIT_RATIO} away — which is
 * the caller's signal to open a new setup.
 */
export function nearestClusterIndex(centres: readonly number[], romM: number): number | undefined {
  let best: number | undefined;
  let bestSeparation = Number.POSITIVE_INFINITY;
  centres.forEach((centre, i) => {
    const seen = separation(romM, centre);
    if (seen < bestSeparation) {
      bestSeparation = seen;
      best = i;
    }
  });
  return best !== undefined && bestSeparation <= SETUP_SPLIT_RATIO ? best : undefined;
}

/**
 * Deterministic row id for one cluster. A total function of the dimensions a
 * setup is per plus the cluster version, percent-encoded on the same reasoning
 * as WA's `baselineKeyId`: re-running the job has to reproduce the id exactly,
 * or every pass would strand the previous pass's rows and any human label on
 * them.
 */
export function setupRowId(key: SetupClusterKey, index: number): string {
  const side = key.side ?? 'both';
  return `${SETUP_CLUSTER_VERSION}:${encode(key.userId)}/${encode(key.exerciseId)}/${side}#${String(index)}`;
}

/**
 * The generated label. Neutral by construction — an ordinal, never a guess at
 * what the physical difference IS. `exercise.confirm_setup` is the only writer
 * that may claim more.
 */
export function setupLabel(index: number): string {
  return `setup ${String(index + 1)}`;
}

/**
 * Re-infer every setup for one (user, exercise) and stamp `setup_id` onto the
 * sets that back them.
 *
 * WORKING SETS ONLY, the same corpus `recalcBaseline` reads. A warm-up ramp and
 * a technique rung are performed at deliberately different intent, and the
 * baseline this feeds scores working sets — a setup inferred off a corpus the
 * baseline never sees would key it against sets it does not read.
 *
 * ON EXPLICIT CALL ONLY: `baselines.recalc { inferSetups: true }` and the
 * `set.end` hook. There is no background loop anywhere in this repo.
 */
export async function inferExerciseSetups(
  store: ExerciseSetupStore,
  key: { userId: string; exerciseId: string },
): Promise<SetupInferenceSummary> {
  const sets = await store.getSetsForExercise({ ...key, purpose: ['working'] });
  const now = new Date().toISOString();
  const summary: SetupInferenceSummary = {
    exerciseId: key.exerciseId,
    clusterVersion: SETUP_CLUSTER_VERSION,
    setups: [],
    setsStamped: 0,
  };
  for (const [side, bucket] of groupBySide(sets)) {
    for (const cluster of clusterSetsByRom(romObservations(bucket))) {
      const setup = await persistSetup(store, sideKey(key, side), cluster, now);
      summary.setups.push(setup);
      summary.setsStamped += cluster.setIds.length;
      for (const setId of cluster.setIds) {
        await store.stampSetSetup(setId, setup.id);
      }
    }
  }
  await retireSupersededSetups(store, key, new Set(summary.setups.map((s) => s.id)), now);
  return summary;
}

/**
 * Write one cluster's row, preserving anything a human put there.
 *
 * `confirmed_at` and the label that came with it are carried forward verbatim:
 * re-inference re-derives which sets belong together, never what the lifter
 * decided to call the result. `detected_at` is likewise the FIRST time this
 * cluster was seen, not the last time the job ran.
 */
async function persistSetup(
  store: ExerciseSetupStore,
  key: SetupClusterKey,
  cluster: SetupCluster,
  now: string,
): Promise<InferredSetup> {
  const id = setupRowId(key, cluster.index);
  const existing = await store.getExerciseSetup(id);
  const confirmed = existing?.confirmedAt !== undefined;
  const label = (confirmed ? existing?.label : undefined) ?? setupLabel(cluster.index);
  const row: StoredExerciseSetup = {
    id,
    userId: key.userId,
    exerciseId: key.exerciseId,
    label,
    detectedAt: existing?.detectedAt ?? now,
    clusterVersion: SETUP_CLUSTER_VERSION,
    ...(existing?.confirmedAt !== undefined ? { confirmedAt: existing.confirmedAt } : {}),
  };
  await store.putExerciseSetup(row);
  return {
    id,
    label,
    ...(key.side !== undefined ? { side: key.side } : {}),
    centreRomM: cluster.centreRomM,
    setCount: cluster.setIds.length,
    confirmed,
  };
}

/**
 * Retire every live setup this pass did not re-derive — rows left behind by a
 * `cluster_version` bump, and clusters whose sets have since moved (relabelled
 * to a guest, or re-scoped to another exercise).
 *
 * RETIRED, NOT DELETED. `exercise_setups` is the FK parent of `sets.setup_id`
 * and of the baseline / anchor keys, and a row a human named is evidence about
 * a bench that still exists. `retired_at` says "no longer inferred" without
 * throwing that away.
 */
async function retireSupersededSetups(
  store: ExerciseSetupStore,
  key: { userId: string; exerciseId: string },
  liveIds: ReadonlySet<string>,
  now: string,
): Promise<void> {
  for (const setup of await store.listExerciseSetups(key)) {
    if (liveIds.has(setup.id)) continue;
    await store.putExerciseSetup({ ...setup, retiredAt: now });
  }
}

/** Sets bucketed by resolved side, first-seen order (so buckets stay chronological). */
function groupBySide(sets: readonly StoredSet[]): Map<StoredSide | undefined, StoredSet[]> {
  const buckets = new Map<StoredSide | undefined, StoredSet[]>();
  for (const set of sets) {
    const bucket = buckets.get(set.side);
    if (bucket === undefined) buckets.set(set.side, [set]);
    else bucket.push(set);
  }
  return buckets;
}

function romObservations(sets: readonly StoredSet[]): SetRomObservation[] {
  const out: SetRomObservation[] = [];
  for (const set of sets) {
    const medianRomM = setMedianRomM(set);
    if (medianRomM !== undefined) out.push({ setId: set.id, medianRomM });
  }
  return out;
}

function sideKey(
  key: { userId: string; exerciseId: string },
  side: StoredSide | undefined,
): SetupClusterKey {
  return { ...key, ...(side !== undefined ? { side } : {}) };
}

/**
 * How far apart two ROMs are, as a ratio ≥ 1 in either direction. A
 * non-positive value carries no signal, so it is infinitely far from
 * everything rather than being allowed to match by accident.
 */
function separation(a: number, b: number): number {
  if (a <= 0 || b <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(a, b) / Math.min(a, b);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}
