#!/usr/bin/env node
// backfill-exercise-ids: one-shot, idempotent labelling of `sessions.exercise_id`
// from `sessions.exercise_name` (VMCP-05.07).
//
// Why this exists: sessions started with `exerciseName` instead of `exerciseId`
// never got an id. Every history read-model keys on `exerciseId`, so months of
// otherwise-good telemetry render blank. The data is fine; only the label is
// missing.
//
// ── The matching contract ─────────────────────────────────────────────────
// A gap beats a guess. A wrong label is worse than a missing one because it is
// undetectable downstream — nothing will ever flag it. So matching is
// deliberately narrow and fully deterministic:
//
//   EXACT      normalized name === a catalog entry's normalized name or alias
//   SIDE       the name is EXACT once a trailing unilateral qualifier is
//              removed — "(left arm)", "— Right Arm", "(right side)". Side is
//              recorded per-set, not per-exercise, so "Cable Chest Fly (right
//              arm)" IS `cable-chest-fly`. The stripped suffix must match the
//              side vocabulary exactly; any other trailing parenthetical (e.g.
//              "(#95 safety validation)", "(Cross-Body)") is NOT stripped.
//   AMBIGUOUS  normalizes onto more than one catalog id → left NULL, reported
//   UNMATCHED  everything else → left NULL, reported
//
// No fuzzy matching, no token overlap, no edit distance, no "closest hit". If
// the name doesn't land on exactly one catalog entry under those two rules it
// stays NULL and shows up in the report for a human to decide. The report is
// the deliverable, not a debug aid.
//
// Catalog source: `src/exercises/seed-catalog.ts` — the same seed set the server
// injects at boot — imported read-only straight from source (Node strips the
// types), so the script never drifts from what `exercise.get` will resolve.
//
// ── Write safety ──────────────────────────────────────────────────────────
//   * dry-run by default; `--apply` is required to write anything
//   * the DB is copied to a timestamped backup before the first write, and the
//     path is printed
//   * `UPDATE ... WHERE exercise_id IS NULL` — never INSERT OR REPLACE.
//     `sessions` is an FK parent of `sets`, which parents `reps`; a REPLACE is
//     DELETE-then-INSERT and would cascade 113 sets / 445 reps into the void
//     (this bit the project before — #79). UPDATE also makes the run idempotent
//     and means an already-labelled session is never touched.
//
// Usage:
//   node scripts/backfill-exercise-ids.mjs                 # dry run, default DB
//   node scripts/backfill-exercise-ids.mjs --apply         # write
//   node scripts/backfill-exercise-ids.mjs --db=/path.sqlite [--apply]
//
// Exit code is 0 for a clean run (including a dry run with unmatched names) and
// non-zero only on failure to open / back up / write.

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const { SEED_CABLE_EXERCISES } = await import(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/exercises/seed-catalog.ts')
);

// ──────────────────────────────────────────────────────────────────────────
// Args
// ──────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const dbArg = argv.find((a) => a.startsWith('--db='));
  return {
    apply: argv.includes('--apply'),
    dbPath:
      dbArg?.slice('--db='.length) ??
      process.env.VMCP_DB_PATH ??
      `${homedir()}/.voltras/vmcp.sqlite`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Normalisation + matching
// ──────────────────────────────────────────────────────────────────────────

/** Hyphen-minus plus the unicode dash family (‐‑‒–—―) and the minus sign. */
const DASH = /[-‐-―−]/g;

/** Split on the LAST dash whose tail contains no further dashes. */
const DASH_SPLIT = /^(.*?)\s*[-‐-―−]\s*([^-‐-―−]*)$/;

/**
 * Case / punctuation / whitespace-insensitive key. Dashes of every flavour
 * (hyphen, en, em) collapse to a space so "Single-Arm" and "single arm" agree;
 * everything else non-alphanumeric is dropped.
 */
function normalize(name) {
  return name
    .toLowerCase()
    .replace(DASH, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Trailing unilateral qualifiers, matched against the WHOLE remaining suffix.
 * Narrow by construction: this list is the entire vocabulary that may be
 * stripped. Anything else stays part of the name.
 */
const SIDE_SUFFIXES = new Set([
  'left',
  'right',
  'left arm',
  'right arm',
  'left side',
  'right side',
  'left leg',
  'right leg',
  'l',
  'r',
]);

/**
 * Strip one trailing side qualifier, whether it arrived as a parenthetical
 * ("... (left arm)") or dash-delimited ("... — Left Arm"). Returns null when
 * there is nothing to strip, so callers can distinguish an EXACT hit from a
 * SIDE hit.
 */
function stripSideQualifier(rawName) {
  const paren = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(rawName);
  if (paren !== null && SIDE_SUFFIXES.has(normalize(paren[2]))) {
    return { base: paren[1].trim(), side: paren[2].trim() };
  }
  const dash = DASH_SPLIT.exec(rawName);
  if (dash !== null && SIDE_SUFFIXES.has(normalize(dash[2]))) {
    return { base: dash[1].trim(), side: dash[2].trim() };
  }
  return null;
}

/**
 * normalized string → Set of catalog ids reachable from it (name or alias).
 * A Set rather than a single id so a collision surfaces as AMBIGUOUS instead of
 * silently resolving to whichever entry the catalog happened to list last.
 */
function buildCatalogIndex(catalog) {
  const index = new Map();
  const add = (key, id) => {
    const norm = normalize(key);
    if (norm === '') return;
    const ids = index.get(norm) ?? new Set();
    ids.add(id);
    index.set(norm, ids);
  };
  for (const exercise of catalog) {
    add(exercise.name, exercise.id);
    for (const alias of exercise.aliases ?? []) add(alias, exercise.id);
  }
  return index;
}

/**
 * Resolve one raw `exercise_name` to a verdict:
 *   { kind: 'exact' | 'side', id, via }
 *   { kind: 'ambiguous', candidates }
 *   { kind: 'unmatched' }
 */
function matchName(rawName, index) {
  const direct = index.get(normalize(rawName));
  if (direct !== undefined) {
    if (direct.size > 1) return { kind: 'ambiguous', candidates: [...direct].sort() };
    return { kind: 'exact', id: [...direct][0] };
  }

  const stripped = stripSideQualifier(rawName);
  if (stripped !== null) {
    const viaSide = index.get(normalize(stripped.base));
    if (viaSide !== undefined) {
      if (viaSide.size > 1) return { kind: 'ambiguous', candidates: [...viaSide].sort() };
      return { kind: 'side', id: [...viaSide][0], via: stripped.side };
    }
  }

  return { kind: 'unmatched' };
}

/**
 * What the script would have guessed had guessing been allowed — reported for
 * unmatched names so the operator has somewhere to start, and NEVER written.
 * Substring containment only, deliberately weak and clearly labelled.
 */
function guessHint(rawName, catalog) {
  const norm = normalize(rawName);
  const hits = catalog
    .filter((e) => {
      const en = normalize(e.name);
      return norm.includes(en) || en.includes(norm);
    })
    .map((e) => e.id);
  return hits.length > 0 ? hits.sort() : [];
}

// ──────────────────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────────────────

function classifyRows(rows, index, catalog) {
  const plan = [];
  const ambiguous = [];
  const unmatched = [];
  let alreadyLabelled = 0;
  let nullName = 0;

  for (const row of rows) {
    if (row.labelled > 0 && row.labelled === row.sessions) {
      alreadyLabelled += row.labelled;
      continue;
    }
    if (row.exercise_name === null) {
      nullName += row.sessions - row.labelled;
      continue;
    }
    const verdict = matchName(row.exercise_name, index);
    if (verdict.kind === 'exact' || verdict.kind === 'side') {
      plan.push({ ...row, id: verdict.id, how: verdict.kind, via: verdict.via });
    } else if (verdict.kind === 'ambiguous') {
      ambiguous.push({ ...row, candidates: verdict.candidates });
    } else {
      unmatched.push({ ...row, hint: guessHint(row.exercise_name, catalog) });
    }
  }
  return { plan, ambiguous, unmatched, alreadyLabelled, nullName };
}

function printReport({ plan, ambiguous, unmatched, alreadyLabelled, nullName }) {
  const pending = (r) => r.sessions - r.labelled;
  const sum = (rows) => rows.reduce((n, r) => n + pending(r), 0);

  console.log('\n── WOULD LABEL ───────────────────────────────────────────────');
  if (plan.length === 0) console.log('  (nothing — every matchable name is already labelled)');
  for (const r of plan.sort((a, b) => pending(b) - pending(a))) {
    const how = r.how === 'side' ? `side-strip "${r.via}"` : 'exact';
    console.log(`  ${String(pending(r)).padStart(3)}  "${r.exercise_name}"  ->  ${r.id}  [${how}]`);
  }

  console.log('\n── AMBIGUOUS (left NULL) ─────────────────────────────────────');
  if (ambiguous.length === 0) console.log('  (none)');
  for (const r of ambiguous) {
    console.log(
      `  ${String(pending(r)).padStart(3)}  "${r.exercise_name}"  -> ${r.candidates.join(' | ')}`,
    );
  }

  console.log('\n── UNMATCHED (left NULL) ─────────────────────────────────────');
  if (unmatched.length === 0) console.log('  (none)');
  for (const r of unmatched.sort((a, b) => pending(b) - pending(a))) {
    const hint = r.hint.length > 0 ? `  would-have-guessed: ${r.hint.join(' | ')}` : '';
    console.log(`  ${String(pending(r)).padStart(3)}  "${r.exercise_name}"${hint}`);
  }

  console.log('\n── SUMMARY ───────────────────────────────────────────────────');
  console.log(`  already labelled (untouched): ${alreadyLabelled}`);
  console.log(`  NULL exercise_name (skipped): ${nullName}`);
  console.log(`  matched, would label:         ${sum(plan)}  (${plan.length} distinct names)`);
  console.log(`  ambiguous, left NULL:         ${sum(ambiguous)}  (${ambiguous.length} names)`);
  console.log(`  unmatched, left NULL:         ${sum(unmatched)}  (${unmatched.length} names)`);
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

function countRows(db) {
  const one = (sql) => db.prepare(sql).get();
  return {
    sessions: one('SELECT COUNT(*) AS n FROM sessions').n,
    labelled: one('SELECT COUNT(*) AS n FROM sessions WHERE exercise_id IS NOT NULL').n,
    sets: one('SELECT COUNT(*) AS n FROM sets').n,
    reps: one('SELECT COUNT(*) AS n FROM reps').n,
  };
}

function backup(dbPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${dbPath}.backup-${stamp}`;
  copyFileSync(dbPath, dest);
  return dest;
}

function main() {
  const { apply, dbPath } = parseArgs(process.argv.slice(2));
  console.log(`DB:   ${dbPath}`);
  console.log(`Mode: ${apply ? 'APPLY (will write)' : 'DRY RUN (no writes — pass --apply)'}`);

  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  try {
    const before = countRows(db);
    console.log(
      `Before: ${before.sessions} sessions (${before.labelled} labelled), ` +
        `${before.sets} sets, ${before.reps} reps`,
    );

    const rows = db
      .prepare(
        `SELECT exercise_name,
                COUNT(*) AS sessions,
                SUM(CASE WHEN exercise_id IS NOT NULL THEN 1 ELSE 0 END) AS labelled
           FROM sessions
          GROUP BY exercise_name`,
      )
      .all();

    const index = buildCatalogIndex(SEED_CABLE_EXERCISES);
    const report = classifyRows(rows, index, SEED_CABLE_EXERCISES);
    printReport(report);

    if (!apply) {
      console.log('\nDry run — nothing written. Re-run with --apply to write.');
      return;
    }
    if (report.plan.length === 0) {
      console.log('\nNothing to write. DB untouched (no backup taken).');
      return;
    }

    console.log(`\nBackup: ${backup(dbPath)}`);

    // UPDATE, never INSERT OR REPLACE — see the header note on #79. The
    // `IS NULL` guard is what makes re-runs no-ops rather than overwrites.
    const update = db.prepare(
      'UPDATE sessions SET exercise_id = ? WHERE exercise_name = ? AND exercise_id IS NULL',
    );
    let written = 0;
    db.exec('BEGIN');
    try {
      for (const r of report.plan) {
        written += Number(update.run(r.id, r.exercise_name).changes);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    const after = countRows(db);
    console.log(`\nWrote ${written} session labels.`);
    console.log(
      `After:  ${after.sessions} sessions (${after.labelled} labelled), ` +
        `${after.sets} sets, ${after.reps} reps`,
    );
    // A cascade would show up here and nowhere else — fail loudly if the child
    // tables moved at all.
    if (after.sets !== before.sets || after.reps !== before.reps) {
      throw new Error(
        `CASCADE DETECTED: sets ${before.sets}->${after.sets}, reps ${before.reps}->${after.reps}. Restore the backup.`,
      );
    }
    console.log('Child rows unchanged (sets + reps intact).');
  } finally {
    db.close();
  }
}

main();
