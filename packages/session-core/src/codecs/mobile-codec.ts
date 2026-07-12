/**
 * Mobile `SessionCodec` — maps the KV-blob `StoredExerciseSession` shape to/from the
 * canonical `WorkoutSession`.
 *
 * Timestamps are already EpochMs. The WA `Set` (`analytics`) is REBUILT by replaying the
 * stored per-phase samples through `createSet`/`addSampleToSet`/`completeSet` — the mobile
 * status quo (`exercise-session-converters.ts`). `status` is carried explicitly.
 *
 * Lossy direction: MCP per-rep `derivedVbt` has no home in the mobile stored shape (reps
 * carry only raw samples). {@link canonicalSetToMobileReps} is the exact projection that
 * drops it. The reverse direction requires a native `summary`; recomputing it from replayed
 * samples when absent (e.g. an MCP-origin session) is a Phase-2 concern (VMCP-03.02+) — the
 * codec throws rather than silently emit a wrong summary.
 */

import { addSampleToSet, completeSet, createSet } from '@voltras/workout-analytics';
import type { Set as WASet, Rep as WARep, LoadSettings } from '@voltras/workout-analytics';
import type { CanonicalSet, CanonicalWorkoutSession } from '../canonical.js';
import type { SessionCodec } from '../repository.js';
import type {
  MobileCompletedSet,
  MobileStoredExerciseSession,
  MobileStoredRep,
} from './stored-shapes.js';

function rebuildAnalytics(set: MobileCompletedSet): WASet {
  const load: LoadSettings = { weight: set.weight, chains: set.chains, eccentric: set.eccentric };
  let wa = createSet(load);
  for (const rep of set.reps) {
    for (const sample of rep.concentric.samples) wa = addSampleToSet(wa, sample);
    for (const sample of rep.eccentric.samples) wa = addSampleToSet(wa, sample);
  }
  return completeSet(wa);
}

/** Project a canonical set's WA reps down to the mobile stored-rep shape (samples only).
 *  This is where MCP `repMeta.derivedVbt` is dropped — mobile has no channel for it. */
export function canonicalSetToMobileReps(set: CanonicalSet): MobileStoredRep[] {
  return set.analytics.reps.map((rep: WARep) => ({
    repNumber: rep.repNumber,
    concentric: { samples: [...rep.concentric.samples] },
    eccentric: { samples: [...rep.eccentric.samples] },
  }));
}

export const mobileCodec: SessionCodec<MobileStoredExerciseSession> = {
  toCanonical(stored: MobileStoredExerciseSession): CanonicalWorkoutSession {
    const sets: CanonicalSet[] = stored.completedSets.map((cs) => ({
      id: `${stored.id}-set-${cs.setIndex}`, // mobile sets are index-identified — synthesize a stable id
      index: cs.setIndex,
      startedAt: cs.startTime,
      endedAt: cs.endTime,
      load: { weight: cs.weight, chains: cs.chains, eccentric: cs.eccentric },
      analytics: rebuildAnalytics(cs),
      summary: {
        meanVelocity: cs.meanVelocity,
        estimatedRPE: cs.estimatedRPE,
        estimatedRIR: cs.estimatedRIR,
        velocityLossPercent: cs.velocityLossPercent,
      },
    }));

    return {
      id: stored.id,
      exerciseId: stored.exerciseId,
      exerciseName: stored.exerciseName,
      startedAt: stored.startTime,
      endedAt: stored.endTime,
      status: stored.status,
      terminationReason: stored.terminationReason,
      sets,
      extra: { mobile: { plan: stored.plan, schemaVersion: stored.schemaVersion } },
    };
  },

  fromCanonical(session: CanonicalWorkoutSession): MobileStoredExerciseSession {
    const completedSets: MobileCompletedSet[] = session.sets.map((cs) => {
      const summary = cs.summary;
      if (!summary) {
        throw new Error(
          `mobileCodec.fromCanonical: set ${cs.id} has no summary; recompute-from-samples is a Phase-2 concern (VMCP-03.02+).`,
        );
      }
      if (cs.endedAt === null) {
        throw new Error(
          `mobileCodec.fromCanonical: set ${cs.id} is in-progress (endedAt null); mobile persists completed sets only.`,
        );
      }
      return {
        setIndex: cs.index,
        startTime: cs.startedAt,
        endTime: cs.endedAt,
        weight: cs.load.weight,
        chains: cs.load.chains,
        eccentric: cs.load.eccentric,
        meanVelocity: summary.meanVelocity,
        estimatedRPE: summary.estimatedRPE,
        estimatedRIR: summary.estimatedRIR,
        velocityLossPercent: summary.velocityLossPercent,
        reps: canonicalSetToMobileReps(cs),
      };
    });

    const mobileExtra = session.extra?.mobile ?? {};
    return {
      id: session.id,
      exerciseId: session.exerciseId ?? '',
      exerciseName: session.exerciseName ?? '',
      startTime: session.startedAt,
      endTime: session.endedAt,
      status: session.status,
      terminationReason: session.terminationReason,
      schemaVersion: (mobileExtra['schemaVersion'] as number | undefined) ?? 3,
      plan: mobileExtra['plan'],
      completedSets,
    };
  },
};
