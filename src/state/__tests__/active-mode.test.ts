// VMCP-02.70 — active-mode derivation keys on the cmd=0x10 echo, not the
// cmd=0x07 state-dump byte (which is an engagement field, not a mode).

import { describe, expect, it } from 'vitest';
import { activeMode } from '../active-mode.js';
import type { DeviceSnapshot } from '../live-state.js';

const device = (over: Partial<DeviceSnapshot> = {}): DeviceSnapshot => ({
  connected: true,
  ...over,
});

describe('activeMode', () => {
  it('returns the cmd=0x10 echo mode name (= requested_mode)', () => {
    expect(activeMode(device({ trainingMode: 'Damper' }))).toBe('Damper');
    expect(activeMode(device({ trainingMode: 'Weight Training' }))).toBe('Weight Training');
  });

  it('returns null when no mode has been observed yet (fresh connect, no echo)', () => {
    expect(activeMode(device())).toBeNull();
  });

  it('ignores the state-dump raw[0] engagement byte — a Damper set at idle reads raw[0]=1 but active_mode stays Damper', () => {
    // The whole point of the fix: raw[0] cannot represent Damper (reads 1=WT at
    // idle). The echo does, so active_mode must not fall back to raw[0].
    const snap = device({ trainingMode: 'Damper', trainingModeRaw: 1 });
    expect(activeMode(snap)).toBe('Damper');
  });
});
