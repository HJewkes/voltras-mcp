/**
 * Which live stage the page shows — single or diverging dual — decided from STATE
 * (VMCP-04.07).
 *
 * Before this, the dual stage was reachable ONLY by hand-typing
 * `?live=1&variant=live-dual`, and it self-described as a preview. Now that it renders
 * real per-slot telemetry (VW-71 / VMCP-04.05) the wall should pick the stage the way it
 * picks every other thing on the page: from what is actually bound. The query param
 * survives as a MANUAL OVERRIDE for testing, it just stops being the only way in.
 *
 * THE RULE: the diverging stage needs BOTH limb slots bound. One bound limb, or none, is
 * the single stage.
 *
 * Why both, rather than "at least one": an ordinary bench session runs on the `primary`
 * slot, so both `left` and `right` come back unbound and the diverging stage would draw an
 * empty axis and an "awaiting both" note while the athlete is mid-lift. The one-bound case
 * is the same failure in slower motion — a session part-way through a bilateral bind (or a
 * `primary` device plus one limb) would lose the telemetry it DOES have to a half-drawn
 * bilateral chart. Falling back costs a bilateral session nothing: the moment the second
 * slot binds, the stage becomes the diverging one.
 *
 * Confidentiality: reads the `/api/snapshot` view model only — no protocol bytes.
 */
import type { Snapshot, SnapshotDeviceEntry } from '../adapter';
import { findLimbEntry, type LimbSide } from '../limb';
import type { LivePageVariant } from './LivePage';

/** The limb slots the diverging stage draws, in its own left-then-right order. */
export const LIMB_SIDES: readonly LimbSide[] = ['left', 'right'];

/**
 * Whether a slot has a Voltra bound to it right now.
 *
 * Presence in `devices[]` IS the binding — the server emits one entry per slot in its slot
 * map, so an entry appears on bind and vanishes on release. The extra `connected !== false`
 * guard covers the other way a device leaves: a BLE drop keeps the slot bound but the limb
 * stops reporting, and a diverging chart with a frozen wing reads as a real (very
 * asymmetric) lift rather than as a lost device.
 *
 * `connected` is checked against explicit `false` rather than truthiness because it is
 * OPTIONAL on the wire: a snapshot that never carried the flag (an older server, a
 * hand-built fixture) means "unknown", and unknown-but-present should stay bound rather
 * than silently disabling the bilateral stage on real hardware.
 */
export function isSlotBound(entry: SnapshotDeviceEntry | undefined): boolean {
  return entry !== undefined && entry.device.connected !== false;
}

/** The limb slots with a device bound, in stable left-then-right order. */
export function boundLimbSides(snapshot: Snapshot | null): LimbSide[] {
  if (snapshot === null) return [];
  return LIMB_SIDES.filter((side) => isSlotBound(findLimbEntry(snapshot.devices, side)));
}

/**
 * The stage the page should show. `override` (from the URL) wins when present; otherwise
 * both limbs bound ⇒ the diverging dual stage, anything else ⇒ single.
 *
 * Deliberately a pure function of the CURRENT snapshot with no memory of the last
 * variant: the transitions this exists to serve — a second Voltra joining mid-session, one
 * dropping — are exactly the moments a remembered variant would be wrong, and every stage
 * below renders from the same snapshot, so the swap carries data with it rather than
 * blanking. Notably it does NOT consult `model.live`, which stays non-null through the
 * whole rest period by design (VW-57).
 */
export function selectLiveVariant(
  snapshot: Snapshot | null,
  override: LivePageVariant | null,
): LivePageVariant {
  if (override !== null) return override;
  return boundLimbSides(snapshot).length === LIMB_SIDES.length ? 'live-dual' : 'live';
}

/**
 * The manual stage override off the URL, or `null` for state-driven selection.
 *
 * `?variant=live-dual` pins the diverging stage (the pre-VMCP-04.07 spelling, kept so
 * existing links and the sim's printed URL keep working); `?variant=live` pins the single
 * one, which is the only way to hold a genuinely bilateral rig on the single stage. An
 * unrecognized value is NOT an override — it falls through to state rather than silently
 * pinning single, so a typo cannot quietly disable the auto-selection this ticket adds.
 */
export function readVariantOverride(search: string): LivePageVariant | null {
  const variant = new URLSearchParams(search).get('variant');
  if (variant === 'live-dual' || variant === 'live') return variant;
  return null;
}
