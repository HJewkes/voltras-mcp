// Pin the set-risk reading on a slot's active set (VW-152 S4): S3's readers feed S1's scorer.
// Nothing reads the reading yet; S5 wires the permit. Any failure leaves no reading, which fails closed.

import { scoreSetRisk } from '../analytics/set-risk.js';
import { log } from '../logger.js';
import type { ActiveSet, LiveState } from './live-state.js';
import type { ServerState } from './server-state.js';
import { readSetRiskInputs } from './set-risk-inputs.js';

/** Score the set from its current start inputs and pin the reading, unless they moved meanwhile. */
export async function pinSetRiskReading(
  state: ServerState,
  live: LiveState,
  setId: string,
): Promise<void> {
  const set = live.set;
  const device = state.setStartDeviceSnapshots.get(setId);
  if (set?.setId !== setId || device === undefined) return;
  const inputs = await readSetRiskInputs(state.store, set, device);
  if (!sameRiskInputs(set, live.set) || state.setStartDeviceSnapshots.get(setId) !== device) return;
  live.attachSetRiskReading(setId, scoreSetRisk(inputs));
}

/** Recompute after the start inputs moved. The old reading goes first; never rejects. */
export async function repinSetRiskReading(
  state: ServerState,
  live: LiveState,
  setId: string,
): Promise<void> {
  if (live.set?.setId !== setId) return;
  live.clearSetRiskReading();
  try {
    await pinSetRiskReading(state, live, setId);
  } catch (err) {
    log.warn('set-risk-pin: re-pin failed; the set is unaffected and has no reading', err);
  }
}

function sameRiskInputs(before: ActiveSet, after: ActiveSet | undefined): boolean {
  return (
    after?.setId === before.setId &&
    after.sessionId === before.sessionId &&
    after.exerciseId === before.exerciseId &&
    after.lifter === before.lifter
  );
}
