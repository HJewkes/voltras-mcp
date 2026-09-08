// Reading the server's outbox. This tool consumes what
// `src/integrations/truecoach/outbox.ts` writes and never renders numbers of
// its own — the strings posted to TrueCoach are exactly the strings
// `report.session_results` produced.

import { mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { DIR_MODE } from './paths.js';

export function listPending(paths) {
  try {
    return readdirSync(paths.pending)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function readEntry(paths, fileName) {
  const path = join(paths.pending, fileName);
  const entry = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof entry.sessionId !== 'string' || typeof entry.date !== 'string') {
    throw new Error(`${path} is not an outbox entry (no sessionId/date)`);
  }
  return entry;
}

export function fileNameFor(sessionId) {
  return `${sessionId}.json`;
}

/** Moves a finished entry out of `pending/`. The ledger is the record; this is tidiness. */
export function moveToSent(paths, fileName) {
  mkdirSync(paths.sent, { recursive: true, mode: DIR_MODE });
  const target = join(paths.sent, fileName);
  renameSync(join(paths.pending, fileName), target);
  return target;
}
