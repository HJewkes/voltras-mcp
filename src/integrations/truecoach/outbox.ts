// The coach-results outbox: one JSON file per ended session, on local disk.
//
// LOCAL by default. This writes a file under `~/.voltras/` and does nothing
// else — no upload, no network call, no browser automation. TrueCoach
// publishes no write API and its terms prohibit third-party applications that
// interact with the service, so the write direction stops at a file a human
// can read or paste.
//
// `VMCP_TRUECOACH_SUBMIT_ON_END='on'` is the one exception, and it is off by
// default: it hands the entry to `tools/truecoach-submit`, a standalone
// Playwright job that is not part of this bundle. Turning it on accepts the
// terms-of-service risk documented in that tool's README. Nothing in this
// process ever reaches TrueCoach itself.
//
// The payload is exactly what `report.session_results` returns, plus
// `generatedAt`. One rendering function serves both, so the file on disk and
// the tool response can never disagree about the same session.
//
// Off by default (`VMCP_TRUECOACH_OUTBOX`), and never able to fail a
// `session.end`: the session is already persisted by the time this runs, and a
// full disk or a read-only home must not turn a completed workout into an
// error.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { log } from '../../logger.js';
import type { ServerState } from '../../state/server-state.js';
import { buildSessionResults, type SessionResults } from '../../tools/report-tools.js';

/** Owner-only, like every other file this server writes under `~/.voltras/`. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Render `sessionId` and drop it in the outbox. Returns normally on every
 * failure path — the caller is `session.end`, whose result must not depend on
 * whether a file landed.
 */
export async function writeSessionOutbox(state: ServerState, sessionId: string): Promise<void> {
  if (state.config.trueCoachOutbox !== 'on') return;
  try {
    const results = await buildSessionResults(state, sessionId);
    if (results.exercises.length === 0) {
      log.debug('truecoach outbox: no working sets in session', sessionId, '— nothing written');
      return;
    }
    const path = writePending(state.config.trueCoachOutboxDir, results);
    log.info('truecoach outbox: wrote', path);
    if (state.config.trueCoachSubmitOnEnd === 'on') spawnSubmitter(sessionId);
  } catch (err) {
    log.warn('truecoach outbox: could not write results for session', sessionId, String(err));
  }
}

/**
 * Hand the entry to `tools/truecoach-submit`, once, detached.
 *
 * One trigger per written entry: no retry, no polling, no interval. The child
 * is unref'd because `session.end` must not wait on a browser, and a failed
 * spawn is logged rather than raised — the entry is still on disk, and the
 * scheduled run or a manual `truecoach-submit` picks it up unchanged.
 */
function spawnSubmitter(sessionId: string): void {
  const script = submitterPath();
  if (!existsSync(script)) {
    log.warn('truecoach submit-on-end: no submitter at', script, '— entry left pending');
    return;
  }
  const child = spawn(process.execPath, [script, '--submit', '--session', sessionId], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (err) => log.warn('truecoach submit-on-end: spawn failed', String(err)));
  child.unref();
  log.info('truecoach submit-on-end: spawned submitter for session', sessionId);
}

/** Three levels up from this module is the package root, from `src/` or `dist/`. */
function submitterPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'tools', 'truecoach-submit', 'src', 'cli.js');
}

/** `<dir>/pending/<sessionId>.json`, creating the directory on demand. */
function writePending(dir: string, results: SessionResults): string {
  const pending = join(dir, 'pending');
  mkdirSync(pending, { recursive: true, mode: DIR_MODE });
  const path = join(pending, `${results.sessionId}.json`);
  const payload = { ...results, generatedAt: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: FILE_MODE,
  });
  return path;
}
