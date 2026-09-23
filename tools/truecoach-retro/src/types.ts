// Row shapes of the truecoach-mbox extraction and the hand-built exercise map. Read-only inputs.

/** One reported set row of `records.jsonl`. */
export interface SetRecord {
  message_id: string;
  workout_due_date: string | null;
  workout_title: string | null;
  exercise_label: string | null;
  exercise_name: string | null;
  prescription_lines: string[];
  set_index: number;
  /** `null` when the block had no warm-up divider; read as a work set. */
  is_warmup: boolean | null;
  sets: number;
  reps: number;
  load: number | null;
  confidence: number;
  decided_by: string;
}

/** One measurement of `checkins.jsonl`. */
export interface CheckinRecord {
  workout_due_date: string | null;
  email_date: string | null;
  field: string;
  value: number | null;
}

/** One row of `exercise-map.json`, keyed by the name as the coach typed it. */
export interface ExerciseMapEntry {
  log_name: string;
  primary_muscle: string | null;
  secondary_muscles: string[];
  /** Groups variants of one movement ('bench', 'squat'); swaps are read inside a family. */
  family: string | null;
  /** The exercise whose own series a main-lift check reads. */
  main_lift: boolean | null;
}

/** Rows that share one exercise header in one email: the unit a prescription covers. */
export interface Block {
  date: string;
  exercise: string | null;
  prescriptionLines: string[];
  rows: SetRecord[];
}
