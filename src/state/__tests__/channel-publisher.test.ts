// Unit tests for `McpChannelPublisher`.
//
// The publisher is a thin wrapper over `server.server.notification(...)` —
// the test asserts the JSON-RPC method and params are forwarded verbatim and
// that the call is fire-and-forget (no rejection escapes when the host has
// no channel listener).

import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { McpChannelPublisher } = await import('../channel-publisher.js');

interface FakeServer {
  server: { notification: ReturnType<typeof vi.fn> };
}

function makeFakeServer(notificationImpl?: () => Promise<void>): FakeServer {
  return {
    server: {
      notification: vi.fn(notificationImpl ?? (() => Promise.resolve())),
    },
  };
}

describe('McpChannelPublisher', () => {
  it('forwards content and meta as notifications/claude/channel params', () => {
    const server = makeFakeServer();
    const publisher = new McpChannelPublisher(
      server as unknown as ConstructorParameters<typeof McpChannelPublisher>[0],
    );

    publisher.publish({
      content: 'Rep 3 complete on set abc.',
      meta: { source: 'voltras', event_type: 'rep_finalized', rep_count: '3' },
    });

    expect(server.server.notification).toHaveBeenCalledTimes(1);
    expect(server.server.notification).toHaveBeenCalledWith({
      method: 'notifications/claude/channel',
      params: {
        content: 'Rep 3 complete on set abc.',
        meta: { source: 'voltras', event_type: 'rep_finalized', rep_count: '3' },
      },
    });
  });

  it('does not throw when the underlying notification rejects (fire-and-forget)', () => {
    const server = makeFakeServer(() => Promise.reject(new Error('no channel listener')));
    const publisher = new McpChannelPublisher(
      server as unknown as ConstructorParameters<typeof McpChannelPublisher>[0],
    );

    expect(() => publisher.publish({ content: 'x', meta: {} })).not.toThrow();
  });

  it('stamps forSlot(...).publish(...) events with slot and an injected emit-time at', () => {
    const server = makeFakeServer();
    const publisher = new McpChannelPublisher(
      server as unknown as ConstructorParameters<typeof McpChannelPublisher>[0],
      () => '2026-09-08T12:00:00.000Z',
    );

    publisher
      .forSlot('primary')
      .publish({ content: 'Rep 3 complete.', meta: { event_type: 'rep_finalized' } });

    expect(server.server.notification).toHaveBeenCalledWith({
      method: 'notifications/claude/channel',
      params: {
        content: 'Rep 3 complete.',
        meta: { slot: 'primary', at: '2026-09-08T12:00:00.000Z', event_type: 'rep_finalized' },
      },
    });
  });

  it('keeps an event-specific ended_at unchanged alongside the injected at', () => {
    const server = makeFakeServer();
    const publisher = new McpChannelPublisher(
      server as unknown as ConstructorParameters<typeof McpChannelPublisher>[0],
      () => '2026-09-08T12:00:00.000Z',
    );

    publisher.forSlot('primary').publish({
      content: 'Set ended.',
      meta: { event_type: 'set_ended', ended_at: '2026-09-08T11:59:50.000Z' },
    });

    expect(server.server.notification).toHaveBeenCalledWith({
      method: 'notifications/claude/channel',
      params: {
        content: 'Set ended.',
        meta: {
          slot: 'primary',
          at: '2026-09-08T12:00:00.000Z',
          event_type: 'set_ended',
          ended_at: '2026-09-08T11:59:50.000Z',
        },
      },
    });
  });
});
