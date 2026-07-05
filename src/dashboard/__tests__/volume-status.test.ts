import { describe, it, expect } from 'vitest';
import {
  toChipVolumeStatus,
  compareVolumeChips,
  type VolumeStatusChip,
} from '../spa/volume-status.js';

const chip = (over: Partial<VolumeStatusChip>): VolumeStatusChip => ({
  muscleGroup: over.muscleGroup ?? 'chest',
  name: over.name ?? 'Chest',
  status: over.status ?? 'ontrack',
  weeklySets: over.weeklySets ?? 0,
});

describe('toChipVolumeStatus', () => {
  it('maps WA landmark classes to titan chip statuses via the documented aliases', () => {
    expect(toChipVolumeStatus('under')).toBe('behind');
    expect(toChipVolumeStatus('maintenance')).toBe('ontrack');
    expect(toChipVolumeStatus('productive')).toBe('target');
    expect(toChipVolumeStatus('over')).toBe('over');
  });
});

describe('compareVolumeChips', () => {
  it('orders the actionable extremes (over, then behind) ahead of the healthy bands', () => {
    const chips = [
      chip({ name: 'A', status: 'ontrack' }),
      chip({ name: 'B', status: 'target' }),
      chip({ name: 'C', status: 'behind' }),
      chip({ name: 'D', status: 'over' }),
    ];
    const ordered = [...chips].sort(compareVolumeChips).map((c) => c.status);
    expect(ordered).toEqual(['over', 'behind', 'target', 'ontrack']);
  });

  it('breaks ties within a status band by weekly sets descending', () => {
    const chips = [
      chip({ name: 'Light', status: 'over', weeklySets: 10 }),
      chip({ name: 'Heavy', status: 'over', weeklySets: 30 }),
    ];
    const ordered = [...chips].sort(compareVolumeChips).map((c) => c.name);
    expect(ordered).toEqual(['Heavy', 'Light']);
  });

  it('breaks a full tie alphabetically for stable ordering', () => {
    const chips = [
      chip({ name: 'Zebra', status: 'ontrack', weeklySets: 5 }),
      chip({ name: 'Alpha', status: 'ontrack', weeklySets: 5 }),
    ];
    const ordered = [...chips].sort(compareVolumeChips).map((c) => c.name);
    expect(ordered).toEqual(['Alpha', 'Zebra']);
  });
});
