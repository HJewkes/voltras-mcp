// B23 (VMCP-06.09): percent-of-load load increment arithmetic, hoisted out of
// `src/tools/plan-tools.ts` (VW-362) so `goal-band.ts` doesn't drag the MCP
// SDK and the store into an analytics module. PURE — same inputs, same
// output, no store, no clock.
//
// `sources/mined/rp-university-idea-backlog.md` "### 14. B23" is the only
// note that proposes this rule, and it states no percent — it explicitly
// discards RP's own (sex-keyed) default rather than quoting it, so there is
// nothing to cite. The production percent in `plan-tools.ts` stays `null`
// until a cited note states a number; this function is exercised directly by
// its own tests with illustrative percents.

/** Smallest weekly load step the device can apply; mirrors `DEVICE_LOAD_STEP_LBS` in `src/tools/warmup-ramp-tools.ts`. */
const DEVICE_LOAD_STEP_LBS = 1;

/** Fixed load-increment floor `computePercentIncrement` falls back to by default. */
const DEFAULT_INCREMENT_FLOOR_LBS = 5;

/** No cap is cited yet, so uncapped (beyond the device-step rounding above) is the default. */
const DEFAULT_INCREMENT_CAP_LBS: number | null = null;

/**
 * B23's arithmetic: `topLoadLbs * percent`, rounded down to the device's load
 * step, floored at the fixed increment, and capped when a cap is supplied.
 */
export function computePercentIncrement(
  topLoadLbs: number,
  percent: number,
  floorLbs: number = DEFAULT_INCREMENT_FLOOR_LBS,
  capLbs: number | null = DEFAULT_INCREMENT_CAP_LBS,
): number {
  const raw = topLoadLbs * (percent / 100);
  const stepped = Math.floor(raw / DEVICE_LOAD_STEP_LBS) * DEVICE_LOAD_STEP_LBS;
  const floored = Math.max(floorLbs, stepped);
  return capLbs === null ? floored : Math.min(floored, capLbs);
}
