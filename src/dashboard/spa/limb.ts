/**
 * The ONE place a device entry is interpreted as a body side (VMCP-04.12).
 *
 * A Voltra is bound to a "slot"; today the slot id doubles as the side, so every
 * user-facing limb label is derived from `slotId` — see {@link limbSide}. A separate
 * nullable `side` field (resolved from the device binding at write time) is landing on
 * the snapshot wire, and because `slotId` and `side` are both plain `string`, switching
 * from one to the other gets NO compiler help: every render path that reads `slotId`
 * directly would become a silently wrong label. Routing all of them through this module
 * makes that switch a one-function change.
 *
 * Behaviour is deliberately identical to the inline derivations it replaces.
 */

/**
 * The structural minimum this module reads off a snapshot device entry — kept local
 * (rather than importing `SnapshotDeviceEntry`) so `adapter.ts` can depend on this module
 * without a cycle. `SnapshotDeviceEntry` satisfies it structurally.
 */
export interface LimbDeviceEntry {
  slotId: string;
  device: { deviceId?: string };
}

/** A body side, i.e. a slot that IS a limb. `null` = bound to no side (e.g. `'primary'`). */
export type LimbSide = 'left' | 'right';

/**
 * The side a device entry represents, or null when the slot is not a limb.
 *
 * THE switch point: when the snapshot carries its own `side`, this reads `entry.side`
 * instead of `entry.slotId` and every caller below follows for free.
 */
export function limbSide(entry: LimbDeviceEntry): LimbSide | null {
  if (entry.slotId === 'left') return 'left';
  if (entry.slotId === 'right') return 'right';
  return null;
}

/**
 * A truthful user-facing label for a device. We hold no user-assigned nickname in the
 * snapshot, so we surface what IS real: the bound side for a limb slot, else the BLE
 * device id, else a bare "Voltra" — never an invented cable name.
 */
export function limbLabel(entry: LimbDeviceEntry): string {
  const side = limbSide(entry);
  if (side === 'left') return 'Left';
  if (side === 'right') return 'Right';
  return entry.device.deviceId ?? 'Voltra';
}

/** The same limb as titan's compact side badge (`VoltraSlot`); null for a non-limb slot. */
export function limbSlotBadge(entry: LimbDeviceEntry): 'L' | 'R' | null {
  const side = limbSide(entry);
  if (side === null) return null;
  return side === 'left' ? 'L' : 'R';
}

/** The entry bound to `side`, or undefined when that limb has no device. */
export function findLimbEntry<T extends LimbDeviceEntry>(
  entries: readonly T[],
  side: LimbSide,
): T | undefined {
  return entries.find((entry) => limbSide(entry) === side);
}
