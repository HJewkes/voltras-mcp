// Reads a `retro-data.json`-shaped object into history read-model inputs (VW-558, S5a).
//
// The retro's per-lift sessions are WA `LiftSessionPoint`s under other key
// names, its boundaries carry the human's marks, and its training days are the
// days the blocks read model dates against. Tests feed it synthetic objects;
// the goal-ramp simulation feeds it a path given at runtime. It never reads a
// file itself and commits no values.
//
// Confidentiality: fitness metadata only — no protocol data (NF-07).

import type { LiftSessionPoint } from '@voltras/workout-analytics';
import { z } from 'zod';

import { BOUNDARY_CHOICES, type HistoryBoundary } from './history-blocks.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const retroSession = z.object({
  date: day,
  topLoad: z.number(),
  topLoadAtModalReps: z.number().nullable(),
  e1rm: z.number().nullable(),
  sets: z.number(),
  totalReps: z.number(),
});

const retroData = z.object({
  adherence: z.object({ trainingDays: z.array(day) }),
  lifts: z.array(
    z.object({
      lift: z.string(),
      modalReps: z.number().nullable(),
      sessions: z.array(retroSession),
    }),
  ),
  boundaries: z.array(
    z.object({
      week: day,
      kinds: z.array(z.enum(['gap', 'load_drop'])),
      gapDays: z.number().nullable(),
      choice: z.enum(BOUNDARY_CHOICES).nullable().optional(),
    }),
  ),
});

export type RetroData = z.input<typeof retroData>;

export interface RetroLiftSeries {
  lift: string;
  modalReps: number | null;
  points: LiftSessionPoint[];
}

export interface RetroHistoryInputs {
  trainingDays: string[];
  boundaries: HistoryBoundary[];
  lifts: RetroLiftSeries[];
}

/** Throws with zod's path on the first key that does not match the retro schema. */
export function historyInputsFromRetroData(json: unknown): RetroHistoryInputs {
  const data = retroData.parse(json);
  return {
    trainingDays: [...data.adherence.trainingDays].sort(),
    boundaries: data.boundaries.map((b) => ({
      week: b.week,
      kinds: b.kinds,
      gapDays: b.gapDays,
      choice: b.choice ?? null,
    })),
    lifts: data.lifts.map((lift) => ({
      lift: lift.lift,
      modalReps: lift.modalReps,
      points: lift.sessions.map((s) => ({
        day: s.date,
        topLoadAtModal: s.topLoadAtModalReps,
        bestE1RM: s.e1rm,
        topLoad: s.topLoad,
        sets: s.sets,
        totalReps: s.totalReps,
      })),
    })),
  };
}
