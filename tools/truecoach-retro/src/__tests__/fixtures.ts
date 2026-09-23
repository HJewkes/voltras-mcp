// Synthetic rows for the tests. No value here comes from a real log.

import { addDays } from '../dates.js';
import type { Block, CheckinRecord, ExerciseMapEntry, SetRecord } from '../types.js';

export function setRow(overrides: Partial<SetRecord> = {}): SetRecord {
  return {
    message_id: 'm1',
    workout_due_date: '2030-01-07',
    workout_title: 'Workout A',
    exercise_label: 'A',
    exercise_name: 'Lift One',
    prescription_lines: ['100 @ 3 x 5'],
    set_index: 1,
    is_warmup: false,
    sets: 1,
    reps: 5,
    load: 100,
    confidence: 0.9,
    decided_by: 'pair_x:prescribed_reps_match',
    ...overrides,
  };
}

export function block(lines: string[], rows: Partial<SetRecord>[]): Block {
  return {
    date: '2030-01-07',
    exercise: 'Lift One',
    prescriptionLines: lines,
    rows: rows.map((r) => setRow({ prescription_lines: lines, ...r })),
  };
}

export function mapEntry(overrides: Partial<ExerciseMapEntry> = {}): ExerciseMapEntry {
  return {
    log_name: 'Lift One',
    primary_muscle: 'chest',
    secondary_muscles: ['triceps'],
    family: 'push',
    main_lift: true,
    ...overrides,
  };
}

/** Twelve sessions of one lift three days apart, and six weekly weigh-ins. */
export function syntheticLog() {
  const rows = Array.from({ length: 12 }, (_, i) => {
    const date = addDays('2030-01-07', 3 * i);
    return [1, 2, 3].map((set) =>
      setRow({ message_id: `m${i}`, workout_due_date: date, set_index: set, load: 100 + i }),
    );
  }).flat();
  const checkins: CheckinRecord[] = Array.from({ length: 6 }, (_, i) => ({
    field: 'Weight',
    workout_due_date: addDays('2030-01-07', 7 * i),
    email_date: null,
    value: 200 - i,
  }));
  return { rows, checkins };
}
