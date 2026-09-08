// The sent-ledger: the record of what has already been posted to TrueCoach.
//
// Append-only. Entries are only ever added, never edited or removed by this
// tool, because the ledger is the only thing standing between a rerun and a
// duplicate post into the coach's workout. A partially-recorded session is
// refused rather than reconciled — the tool cannot tell whether the missing
// exercises failed or were posted and lost, and guessing wrong double-posts.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { DIR_MODE } from './paths.js';

const FILE_MODE = 0o600;

export function readLedger(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`ledger at ${path} is unreadable: ${String(err)}`);
  }
}

/** Rewrites the file with `records` appended. Never drops an existing record. */
export function appendLedger(path, records) {
  const entries = [...readLedger(path), ...records];
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
  writeFileSync(path, `${JSON.stringify({ entries }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: FILE_MODE,
  });
  return entries;
}

/**
 * `'none'`, `'partial'` or `'all'` — how much of `entry` the ledger already
 * has. `'all'` is a completed post; `'partial'` is the refusal case.
 */
export function ledgerCoverage(ledgerEntries, entry) {
  const posted = new Set(
    ledgerEntries
      .filter((record) => record.sessionId === entry.sessionId)
      .map((record) => record.exerciseId),
  );
  const hits = entry.exercises.filter((exercise) => posted.has(exercise.exerciseId)).length;
  if (hits === 0) return 'none';
  return hits === entry.exercises.length ? 'all' : 'partial';
}

/** The records written once a submit succeeds — one per exercise. */
export function buildRecords(entry, screenshot, sentAt = new Date().toISOString()) {
  return entry.exercises.map((exercise) => ({
    sessionId: entry.sessionId,
    exerciseId: exercise.exerciseId,
    sentAt,
    screenshot,
  }));
}
