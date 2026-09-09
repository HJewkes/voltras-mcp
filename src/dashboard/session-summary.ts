// Re-export shim (VMCP-03.03): the session-completion read-model moved to
// `read-models/session-summary.ts` alongside its sibling projectors. Kept here
// so `report-tools.ts` and the SPA keep importing from this path without churn.

export {
  buildSessionSummary,
  resolveSummarySessionId,
  type DashboardSessionStore,
  type SessionSummaryExercise,
  type SessionSummaryProgression,
  type SessionSummarySet,
  type SessionSummaryView,
} from './read-models/session-summary.js';
