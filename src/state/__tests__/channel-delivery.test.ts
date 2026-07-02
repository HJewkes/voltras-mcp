// Unit tests for ChannelDeliveryTracker (src/state/channel-delivery.ts).
//
// The tracker is a small in-memory ledger for the channel delivery round-trip.
// We inject a deterministic clock so timestamp assertions are stable.
import { describe, expect, it } from 'vitest';

import { ChannelDeliveryTracker } from '../channel-delivery.js';

const PROBE_ISO = '2026-07-02T10:00:00.000Z';
const CONFIRM_ISO = '2026-07-02T10:00:05.000Z';

describe('ChannelDeliveryTracker', () => {
  it('starts with a null, zeroed snapshot', () => {
    const tracker = new ChannelDeliveryTracker(() => PROBE_ISO);
    expect(tracker.snapshot()).toEqual({
      lastProbeAt: null,
      lastProbeNonce: null,
      lastConfirmedAt: null,
      lastConfirmedNonce: null,
      lastConfirmationMatchedProbe: false,
      confirmations: 0,
    });
  });

  it('records a probe nonce + timestamp without touching confirmation fields', () => {
    const tracker = new ChannelDeliveryTracker(() => PROBE_ISO);
    tracker.recordProbe('abc');
    const snap = tracker.snapshot();
    expect(snap.lastProbeNonce).toBe('abc');
    expect(snap.lastProbeAt).toBe(PROBE_ISO);
    expect(snap.lastConfirmedAt).toBeNull();
    expect(snap.confirmations).toBe(0);
  });

  it('marks a matching confirmation as a genuine round-trip', () => {
    let now = PROBE_ISO;
    const tracker = new ChannelDeliveryTracker(() => now);
    tracker.recordProbe('abc');
    now = CONFIRM_ISO;
    const result = tracker.recordConfirmation('abc');
    expect(result).toEqual({
      lastProbeAt: PROBE_ISO,
      lastProbeNonce: 'abc',
      lastConfirmedAt: CONFIRM_ISO,
      lastConfirmedNonce: 'abc',
      lastConfirmationMatchedProbe: true,
      confirmations: 1,
    });
  });

  it('marks a non-matching confirmation as not-a-round-trip but still records it', () => {
    const tracker = new ChannelDeliveryTracker(() => CONFIRM_ISO);
    tracker.recordProbe('expected');
    const result = tracker.recordConfirmation('stale');
    expect(result.lastConfirmationMatchedProbe).toBe(false);
    expect(result.lastConfirmedNonce).toBe('stale');
    expect(result.lastConfirmedAt).toBe(CONFIRM_ISO);
    expect(result.confirmations).toBe(1);
  });

  it('treats a confirmation before any probe as unmatched', () => {
    const tracker = new ChannelDeliveryTracker(() => CONFIRM_ISO);
    const result = tracker.recordConfirmation('orphan');
    expect(result.lastConfirmationMatchedProbe).toBe(false);
    expect(result.lastProbeNonce).toBeNull();
    expect(result.confirmations).toBe(1);
  });

  it('increments the confirmation counter across repeated confirmations', () => {
    const tracker = new ChannelDeliveryTracker(() => CONFIRM_ISO);
    tracker.recordProbe('abc');
    tracker.recordConfirmation('abc');
    tracker.recordConfirmation('abc');
    tracker.recordConfirmation('abc');
    expect(tracker.snapshot().confirmations).toBe(3);
  });

  it('re-evaluates matchedProbe against the most recent probe', () => {
    const tracker = new ChannelDeliveryTracker(() => CONFIRM_ISO);
    tracker.recordProbe('first');
    expect(tracker.recordConfirmation('first').lastConfirmationMatchedProbe).toBe(true);
    // A newer probe supersedes the old nonce; confirming the stale one no longer matches.
    tracker.recordProbe('second');
    expect(tracker.recordConfirmation('first').lastConfirmationMatchedProbe).toBe(false);
    expect(tracker.recordConfirmation('second').lastConfirmationMatchedProbe).toBe(true);
  });
});
