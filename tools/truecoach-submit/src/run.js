// One entry is one TrueCoach workout is one browser pass.
//
// Ordering is the safety property. The ledger is checked before anything else
// and appended immediately after the click, so a crash anywhere in between
// leaves a record that the next run reads as "already sent" rather than
// posting the same numbers twice.

import { LoginRequiredError, firstPage, openContext } from './browser.js';
import { AbortEntry } from './errors.js';
import { checkFreshness, DEFAULT_STALE_HOURS } from './freshness.js';
import { appendLedger, buildRecords, ledgerCoverage, readLedger } from './ledger.js';
import { matchExercises } from './match.js';
import { fileNameFor, listPending, moveToSent, readEntry } from './outbox.js';
import { RESULTS_TEXTAREA } from './selectors.js';
import { captureScreenshot, clickSubmit, fillSlots, openWorkout, readSlots } from './workout.js';

/** Codes that mean the entry needs no attention. Everything else exits non-zero. */
const CLEAN_CODES = new Set(['sent', 'dry_run', 'already_sent']);

export async function runAll(paths, options) {
  const files = selectFiles(paths, options);
  const ledgerEntries = readLedger(paths.ledger);
  const results = [];
  const queued = [];
  for (const file of files) {
    const entry = readEntry(paths, file);
    const refusal = preCheck(paths, ledgerEntries, entry, file, options);
    if (refusal !== undefined) results.push(refusal);
    else queued.push({ entry, file });
  }
  if (queued.length > 0) results.push(...(await drive(paths, queued, options)));
  return { results, exitCode: results.every((r) => CLEAN_CODES.has(r.code)) ? 0 : 1 };
}

function selectFiles(paths, options) {
  if (options.session === undefined) return listPending(paths);
  const file = fileNameFor(options.session);
  if (!listPending(paths).includes(file)) {
    throw new Error(`no pending outbox entry for session "${options.session}"`);
  }
  return [file];
}

/** The checks that need no browser: the ledger, then freshness. */
function preCheck(paths, ledgerEntries, entry, file, options) {
  const coverage = ledgerCoverage(ledgerEntries, entry);
  if (coverage === 'all') {
    moveToSent(paths, file);
    return { sessionId: entry.sessionId, code: 'already_sent', detail: 'every exercise in ledger' };
  }
  if (coverage === 'partial') {
    return {
      sessionId: entry.sessionId,
      code: 'ledger_partial',
      detail: 'some exercises already sent',
    };
  }
  const stale = checkFreshness(entry, {
    staleHours: options.staleHours ?? DEFAULT_STALE_HOURS,
  });
  return stale === undefined ? undefined : { sessionId: entry.sessionId, ...stale };
}

/** One browser for the whole run; one page pass per entry. */
async function drive(paths, queued, options) {
  const context = await openContext(paths.profile, {
    headless: options.headless !== false,
    launcher: options.launcher,
  });
  const results = [];
  try {
    const page = await firstPage(context);
    for (const item of queued) {
      const result = await attempt(page, paths, item, options);
      results.push(result);
      if (result.code === 'login_required') break;
    }
  } finally {
    await context.close();
  }
  return results;
}

async function attempt(page, paths, { entry, file }, options) {
  try {
    return await runEntry(page, paths, entry, file, options);
  } catch (err) {
    if (err instanceof LoginRequiredError) {
      return { sessionId: entry.sessionId, code: 'login_required', detail: err.message };
    }
    if (err instanceof AbortEntry) {
      return { sessionId: entry.sessionId, code: err.code, detail: err.detail };
    }
    return { sessionId: entry.sessionId, code: 'error', detail: String(err) };
  }
}

export async function runEntry(page, paths, entry, file, options) {
  await openWorkout(page, entry.date);
  const fills = planFills(entry, await readSlots(page));
  await fillSlots(page, fills);
  const screenshot = await captureScreenshot(page, paths, entry.sessionId);
  if (!options.submit) {
    return {
      sessionId: entry.sessionId,
      code: 'dry_run',
      detail: 'filled, not submitted',
      screenshot,
    };
  }
  await clickSubmit(page);
  appendLedger(paths.ledger, buildRecords(entry, screenshot));
  moveToSent(paths, file);
  return {
    sessionId: entry.sessionId,
    code: 'sent',
    detail: `${fills.length} exercises`,
    screenshot,
  };
}

/** Resolves every exercise to a distinct results box, or aborts with no fills. */
function planFills(entry, slots) {
  const { matches, unmatched } = matchExercises(entry.exercises, slots);
  if (unmatched !== undefined) {
    const names = unmatched.map((miss) => `${miss.exerciseName} (${miss.reason})`);
    throw new AbortEntry('unmatched', names.join('; '));
  }
  const boxless = matches.find((match) => match.slot.hasResultsBox === false);
  if (boxless !== undefined) {
    throw new AbortEntry(
      'selector_missing',
      `"${boxless.slot.title}" has no \`${RESULTS_TEXTAREA}\``,
    );
  }
  return matches.map((match) => ({ index: match.slot.index, block: match.result }));
}
