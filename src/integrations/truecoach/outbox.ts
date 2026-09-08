// The coach-results outbox: one JSON file per ended session, on local disk.
//
// LOCAL ONLY. This writes a file under `~/.voltras/` and does nothing else —
// no upload, no network call, no browser automation. TrueCoach publishes no
// write API and its terms prohibit third-party applications that interact with
// the service, so the write direction stops at a file a human can read or
// paste. The directory name records the intent; it does not create a pipe.
//
// The payload is exactly what `report.session_results` returns, plus
// `generatedAt`. One rendering function serves both, so the file on disk and
// the tool response can never disagree about the same session.
//
// Off by default (`VMCP_TRUECOACH_OUTBOX`), and never able to fail a
// `session.end`: the session is already persisted by the time this runs, and a
// full disk or a read-only home must not turn a completed workout into an
// error.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  } catch (err) {
    log.warn('truecoach outbox: could not write results for session', sessionId, String(err));
  }
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
