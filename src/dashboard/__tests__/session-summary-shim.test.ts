// The session-completion read-model relocated to `read-models/session-summary.ts`
// (VMCP-03.03); `dashboard/session-summary.ts` is now a re-export shim so
// `report-tools.ts` and the SPA keep importing from the old path with no churn.

import { describe, expect, it } from 'vitest';

import * as shim from '../session-summary.js';
import * as canonical from '../read-models/session-summary.js';

describe('session-summary.ts re-export shim', () => {
  it('re-exports the same buildSessionSummary and resolveSummarySessionId bindings', () => {
    expect(shim.buildSessionSummary).toBe(canonical.buildSessionSummary);
    expect(shim.resolveSummarySessionId).toBe(canonical.resolveSummarySessionId);
  });
});
