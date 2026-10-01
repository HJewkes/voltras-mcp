// Per-slot, per-interval line budget for the cue-delivery layer (VW-140 plan 3.3).
//
// `admit` decides whether one spoken line may play and records the decision on
// the ledger. Refused lines are dropped, never queued into a later interval.

import type { SetRiskReading } from '../../analytics/set-risk.js';
import type { Tier } from '../../tools/tier-signal.js';
import type { CueSettings } from '../cue-settings.js';
import { densityFor, MAX_LINES_PER_INTERVAL } from './density.js';
import type { Interval } from './interval.js';

export type CueLine =
  | { kind: 'focus'; focusId: string }
  | { kind: 'announcement'; category: string };

export interface IntraSetContext {
  slot: string;
  setId: string;
  settings: CueSettings;
}

/** The VW-152 seam: whether any intra-set sound is safe for this set. */
export type IntraSetPermit = (context: IntraSetContext) => boolean;

export const defaultIntraSetPermit: IntraSetPermit = ({ settings }) => settings.midSetEnabled;

export interface BudgetRequest {
  slot: string;
  setId: string;
  interval: Interval;
  line: CueLine;
  /** `null` until the tier lookup resolves. */
  tier: Tier | null;
  settings: CueSettings;
  intraSetPermit: IntraSetPermit;
  /** Present only under `VMCP_CUES_MIDSET=risk`: the set's pinned reading, or `null` when none. */
  risk?: LedgerRisk;
}

/** What the ledger keeps of a set-risk reading (VW-615). */
export type LedgerRisk = Pick<SetRiskReading, 'band' | 'points' | 'factors' | 'vetoes'> | null;

export type AdmitReason = 'within_budget';

export type RefuseReason =
  | 'midset_disabled'
  | 'intra_permit_denied'
  | 'risk_band_amber'
  | 'risk_band_red'
  | 'risk_reading_missing'
  | 'new_focus_intra'
  | 'interval_cap'
  | 'tier_density';

export type BudgetDecision =
  | { admit: true; reason: AdmitReason }
  | { admit: false; reason: RefuseReason };

export interface LedgerEntry {
  slot: string;
  setId: string;
  interval: Interval;
  line: CueLine;
  decision: BudgetDecision;
  risk?: LedgerRisk;
}

export interface CueLedger {
  readonly entries: LedgerEntry[];
}

export function createLedger(): CueLedger {
  return { entries: [] };
}

/** Decide one line and append the decision to the ledger. */
export function admit(ledger: CueLedger, request: BudgetRequest): BudgetDecision {
  const decision = decide(ledger, request);
  const { slot, setId, interval, line, risk } = request;
  ledger.entries.push({
    slot,
    setId,
    interval,
    line,
    decision,
    ...(risk === undefined ? {} : { risk }),
  });
  return decision;
}

function decide(ledger: CueLedger, request: BudgetRequest): BudgetDecision {
  const refusal = request.interval === 'intra' ? intraRefusal(ledger, request) : null;
  if (refusal !== null) return { admit: false, reason: refusal };
  const spoken = admittedIn(ledger, request, request.interval).length;
  if (spoken >= MAX_LINES_PER_INTERVAL) return { admit: false, reason: 'interval_cap' };
  if (spoken >= densityFor(request.tier, request.interval)) {
    return { admit: false, reason: 'tier_density' };
  }
  return { admit: true, reason: 'within_budget' };
}

function intraRefusal(ledger: CueLedger, request: BudgetRequest): RefuseReason | null {
  const { slot, setId, settings, line } = request;
  if (!midSetAllowed(settings)) return 'midset_disabled';
  if (!request.intraSetPermit({ slot, setId, settings })) return permitRefusal(request.risk);
  if (line.kind === 'focus' && line.focusId !== preSetFocus(ledger, request)) {
    return 'new_focus_intra';
  }
  return null;
}

/** Under `risk` the refusal names the band that denied, so the ledger never needs free text. */
function permitRefusal(risk: LedgerRisk | undefined): RefuseReason {
  if (risk === undefined) return 'intra_permit_denied';
  if (risk === null) return 'risk_reading_missing';
  if (risk.band === 'amber') return 'risk_band_amber';
  if (risk.band === 'red') return 'risk_band_red';
  return 'intra_permit_denied';
}

// VW-614: `risk` passes here and leaves the decision to the permit; an unknown mode reads as `off`.
function midSetAllowed(settings: CueSettings): boolean {
  return settings.midSetMode === 'on' || settings.midSetMode === 'risk';
}

/** The first focus admitted in this set's pre interval, or `null` when none was spoken. */
function preSetFocus(ledger: CueLedger, request: BudgetRequest): string | null {
  for (const entry of admittedIn(ledger, request, 'pre')) {
    if (entry.line.kind === 'focus') return entry.line.focusId;
  }
  return null;
}

function admittedIn(ledger: CueLedger, request: BudgetRequest, interval: Interval): LedgerEntry[] {
  return ledger.entries.filter(
    (entry) =>
      entry.decision.admit &&
      entry.slot === request.slot &&
      entry.setId === request.setId &&
      entry.interval === interval,
  );
}
