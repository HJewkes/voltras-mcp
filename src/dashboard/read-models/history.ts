// Pure read-model for `GET /api/history` (VMCP-03.03).
//
// `buildHistoryView` shapes an already-fetched page of sessions into the
// response the live page's history rail renders. It performs NO I/O: the
// caller (`server.ts`'s `fetchHistory`) owns the `?limit=` parsing and the
// `store.listSessions` call, this module owns the output shape — the same
// split `read-models/plan-tree.ts` uses.

import type { StoredSession } from '../../store/types.js';

/** Everything `buildHistoryView` needs, already read out of the store. */
export interface HistoryRows {
  sessions: readonly StoredSession[];
}

/** The session page as `GET /api/history` returns it — a straight passthrough today. */
export function buildHistoryView(rows: HistoryRows): readonly StoredSession[] {
  return rows.sessions;
}
