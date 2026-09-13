// Unit tests for the in-memory coach transport (VW-286).
//
// The point of this transport is that rows 10-12 are testable with no Apple
// ID, no second macOS user and no BlueBubbles server, so what is asserted here
// is that it records faithfully and fails in the two shapes a real channel
// fails in.

import { describe, expect, it } from 'vitest';
import { MockCoachTransport } from '../mock-transport.js';
import { CoachMessageRejectedError, CoachTransportUnavailableError } from '../transport.js';

describe('MockCoachTransport', () => {
  it('records every message in order, with the handle it was given', async () => {
    const transport = new MockCoachTransport(() => new Date('2026-09-13T18:00:00.000Z'));
    await transport.send('lifter@example.com', 'first');
    await transport.send('lifter@example.com', 'second');

    expect(transport.sent.map((m) => m.text)).toEqual(['first', 'second']);
    expect(transport.sent[0]?.handle).toBe('lifter@example.com');
    expect(transport.sent[0]?.at.toISOString()).toBe('2026-09-13T18:00:00.000Z');
  });

  it('raises the two failure shapes on demand and records nothing while failing', async () => {
    const transport = new MockCoachTransport();
    transport.failWith('unavailable');
    await expect(transport.send('h', 'x')).rejects.toBeInstanceOf(CoachTransportUnavailableError);

    transport.failWith('rejected');
    await expect(transport.send('h', 'x')).rejects.toBeInstanceOf(CoachMessageRejectedError);
    expect(transport.sent).toEqual([]);

    transport.recover();
    await transport.send('h', 'x');
    expect(transport.sent).toHaveLength(1);
  });
});
