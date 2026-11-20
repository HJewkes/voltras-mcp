// Synthetic session-summary payloads for the completion page's model tests (VW-937).
// Copied from the design inputs, with `progression.targetWeightLbs` set to the PLANNED
// load the server reports there, not next session's load, and every `delta` and
// `reasoning` set to what `computeProgressionDelta` returns for the sets (pinned by
// `analytics/__tests__/rep-band.test.ts`).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  SessionSummaryExercise,
  SessionSummaryView,
} from '../../../read-models/session-summary-view.js';

export const SUMMARY_FIXTURES = [
  '1-current',
  '2-full-session',
  '3-edges',
  '4-form-breakdown',
] as const;

export type SummaryFixture = (typeof SUMMARY_FIXTURES)[number];

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadSummary(name: SummaryFixture): SessionSummaryView {
  return JSON.parse(readFileSync(join(HERE, `${name}.json`), 'utf8')) as SessionSummaryView;
}

export function summaryExercise(name: SummaryFixture, exercise: string): SessionSummaryExercise {
  const found = loadSummary(name).exercises.find((e) => e.name === exercise);
  if (found === undefined) throw new Error(`fixture ${name} has no exercise ${exercise}`);
  return found;
}
