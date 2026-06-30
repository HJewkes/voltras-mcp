// VMCP-02.09 — applied-mode name mapping (cmd=0x07 byte → name).

import { describe, expect, it } from 'vitest';
import { activeModeName } from '../active-mode.js';

describe('activeModeName', () => {
  it('returns null when no state-dump has been observed (undefined)', () => {
    expect(activeModeName(undefined)).toBeNull();
  });

  it('maps 0 to "transitional" (mid-mode-switch, no active mode)', () => {
    expect(activeModeName(0)).toBe('transitional');
  });

  it('maps the hardware-confirmed bytes 1 and 2 to mode names', () => {
    expect(activeModeName(1)).toBe('Weight Training');
    expect(activeModeName(2)).toBe('Resistance Band');
  });

  it('renders unconfirmed bytes (>=3) as unverified(<n>) rather than guessing', () => {
    // 7 = Isokinetic in the SDK enum, but the cmd=0x07 byte for Isokinetic is
    // not yet hardware-confirmed — we must not assert the name.
    expect(activeModeName(7)).toBe('unverified(7)');
    expect(activeModeName(3)).toBe('unverified(3)');
    expect(activeModeName(8)).toBe('unverified(8)');
  });
});
