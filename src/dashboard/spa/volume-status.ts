/**
 * Pure volume-status view mapping (VMCP-01.54).
 *
 * Converts WA's MEV/MAV/MRV landmark classification into titan
 * `MuscleGroupChip` statuses and orders muscles so the ones needing attention
 * (over-/under-dosed) surface first.
 *
 * No titan RUNTIME import — the `MuscleGroupChipProps` import is type-only and
 * erases at build, so this module stays node-vitest-safe. The grouping +
 * display-name resolution that DOES need the body-highlighter subpath lives in
 * `bodymap.ts` (`buildVolumeStatusChips`), which is reached only via the lazy
 * panel chunk.
 */
import type { MuscleGroupChipProps } from '@titan-design/react-ui';
import type { VolumeStatusName } from '@voltras/workout-analytics';

/** titan chip status enum (`'untrained' | 'behind' | 'ontrack' | 'target' | 'over'`). */
export type ChipVolumeStatus = NonNullable<MuscleGroupChipProps['volumeStatus']>;

/** One muscle's weekly-volume status, ready for a titan `MuscleGroupChip`. */
export interface VolumeStatusChip {
  /** titan `MuscleGroup` enum value, kept as a plain string to stay import-free. */
  muscleGroup: string;
  /** Human-readable muscle name (titan `MUSCLE_DISPLAY_NAMES`). */
  name: string;
  status: ChipVolumeStatus;
  weeklySets: number;
}

/**
 * WA landmark class → titan chip status, following titan's own documented
 * aliases (under=behind, maintenance=ontrack, productive=target).
 */
const WA_TO_CHIP: Record<VolumeStatusName, ChipVolumeStatus> = {
  under: 'behind',
  maintenance: 'ontrack',
  productive: 'target',
  over: 'over',
};

export function toChipVolumeStatus(name: VolumeStatusName): ChipVolumeStatus {
  return WA_TO_CHIP[name];
}

/**
 * Attention order for the chip list: the extremes (over-/under-dosed) read
 * first because they are the actionable states, then productive (in the target
 * zone), then maintenance. Ties break by weekly set count descending so the
 * busiest muscle leads its band, then alphabetically for stability.
 */
const STATUS_RANK: Record<ChipVolumeStatus, number> = {
  over: 0,
  behind: 1,
  target: 2,
  ontrack: 3,
  untrained: 4,
};

export function compareVolumeChips(a: VolumeStatusChip, b: VolumeStatusChip): number {
  const byRank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (byRank !== 0) return byRank;
  if (b.weeklySets !== a.weeklySets) return b.weeklySets - a.weeklySets;
  return a.name.localeCompare(b.name);
}
