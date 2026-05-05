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
});
