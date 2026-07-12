/**
 * Paired fixtures for the round-trip spec (session-core-roundtrip-spec.md).
 *
 * A mobile `StoredExerciseSession` and an MCP `StoredSession`+`StoredSet[]` that share the
 * SAME sample data (1 session · 1 set · 2 reps · 2 samples/phase) so both map to the same
 * canonical analytics core at the sample level — while differing on exactly the three known
 * lossy dimensions (chains/ecc, derivedVbt, plan↔program_assignments).
 *
 * Factory functions (not shared constants) so each test gets fresh, un-aliased objects.
 */

import { addSampleToSet, completeSet, createSet, MovementPhase } from '@voltras/workout-analytics';
import type {
  Set as WASet,
  Rep as WARep,
  LoadSettings,
  WorkoutSample,
} from '@voltras/workout-analytics';
import type { McpStored, McpStoredRep, MobileStoredExerciseSession } from '../stored-shapes.js';

const CON = MovementPhase.CONCENTRIC; // 1
const ECC = MovementPhase.ECCENTRIC; // 3

const sample = (
  sequence: number,
  timestamp: number,
  phase: MovementPhase,
  position: number,
  velocity: number,
  force: number,
): WorkoutSample => ({ sequence, timestamp, phase, position, velocity, force });

// 2 reps × 2 samples/phase. CON→ECC→CON transitions drive WA rep segmentation.
const repSamples = () => [
  [sample(1, 1000, CON, 0.1, 0.5, 60), sample(2, 1050, CON, 0.6, 0.6, 60)],
  [sample(3, 1100, ECC, 0.9, 0.4, 60), sample(4, 1150, ECC, 0.3, 0.3, 60)],
  [sample(5, 1200, CON, 0.1, 0.55, 60), sample(6, 1250, CON, 0.7, 0.65, 60)],
  [sample(7, 1300, ECC, 0.9, 0.35, 60), sample(8, 1350, ECC, 0.2, 0.25, 60)],
];

function buildWaSet(load: LoadSettings): WASet {
  let wa = createSet(load);
  for (const phase of repSamples()) {
    for (const s of phase) wa = addSampleToSet(wa, s);
  }
  return completeSet(wa);
}

// ── MCP fixture ──────────────────────────────────────────────────────────────
// Reps are real WA reps (full Phase graph) decorated with row metadata + finalized VBT.
export function makeMcpFixture(): McpStored {
  const waSet = buildWaSet({ weight: 60, chains: 0, eccentric: 0 });
  const derivedBlocks: unknown[] = [
    { correctedMeanVelocity: 0.6, source: 'firmware' },
    { correctedMeanVelocity: 0.58, source: 'firmware' },
  ];
  const reps: McpStoredRep[] = waSet.reps.map((rep: WARep, i: number) => ({
    ...rep,
    id: `r${i + 1}`,
    setId: 'set-9a7c',
    index: i,
    derived: derivedBlocks[i],
  }));

  return {
    session: {
      id: 'sess-1f0e',
      exerciseId: 'cable-row',
      exerciseName: 'Cable Row',
      startedAt: '2026-07-12T16:00:00.000Z',
      endedAt: '2026-07-12T16:01:30.000Z',
      notes: 'felt strong',
    },
    sets: [
      {
        id: 'set-9a7c',
        sessionId: 'sess-1f0e',
        startedAt: '2026-07-12T16:00:05.000Z',
        endedAt: '2026-07-12T16:00:40.000Z',
        weightLbs: 60,
        trainingMode: 'cable',
        partial: false,
        reps,
      },
    ],
    assignments: [{ programId: 'prog-1', week: 2, day: 'A' }],
  };
}

// ── mobile fixture ───────────────────────────────────────────────────────────
// Reps carry only raw per-phase samples (lossy subset). chains/ecc PRESENT; plan embedded.
export function makeMobileFixture(): MobileStoredExerciseSession {
  const [r1c, r1e, r2c, r2e] = repSamples();
  return {
    id: 'session_1752336000000_ab12',
    exerciseId: 'cable-row',
    exerciseName: 'Cable Row',
    startTime: 1752336000000,
    endTime: 1752336090000,
    status: 'completed',
    terminationReason: 'user_ended',
    schemaVersion: 3,
    plan: { exerciseId: 'cable-row', goal: 'strength', generatedBy: 'discovery' },
    completedSets: [
      {
        setIndex: 0,
        startTime: 1752336005000,
        endTime: 1752336040000,
        weight: 60,
        chains: 15,
        eccentric: 20,
        meanVelocity: 0.62,
        estimatedRPE: 8,
        estimatedRIR: 2,
        velocityLossPercent: 14.3,
        reps: [
          { repNumber: 1, concentric: { samples: r1c! }, eccentric: { samples: r1e! } },
          { repNumber: 2, concentric: { samples: r2c! }, eccentric: { samples: r2e! } },
        ],
      },
    ],
  };
}

/** Sample-level projection of a WA set — the grain assertion #1 (core equivalence) checks.
 *  Deliberately ignores WA `Phase` internal accumulators (which legitimately differ when
 *  loadSettings differ), comparing only the `{sequence,timestamp,phase,position,velocity,force}`
 *  the spec enumerates. */
export function repSampleData(waSet: WASet) {
  const pick = (s: WorkoutSample) => ({
    sequence: s.sequence,
    timestamp: s.timestamp,
    phase: s.phase,
    position: s.position,
    velocity: s.velocity,
    force: s.force,
  });
  return waSet.reps.map((r: WARep) => ({
    repNumber: r.repNumber,
    concentric: r.concentric.samples.map(pick),
    eccentric: r.eccentric.samples.map(pick),
  }));
}
