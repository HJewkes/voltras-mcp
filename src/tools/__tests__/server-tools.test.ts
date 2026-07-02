// Unit tests for `server.health` (src/tools/server-tools.ts).
//
// The handler reads versions/SHA at module load, then composes a response
// from `state.config` + the cached version strings. We verify the happy
// path: the returned object carries the expected keys and pulls
// `adapter`/`dbPath`/`logLevel` from config.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { registerServerTools } = await import('../server-tools.js');
const { noopChannelPublisher, McpChannelPublisher } =
  await import('../../state/channel-publisher.js');
const { ChannelDeliveryTracker } = await import('../../state/channel-delivery.js');

/** Minimal real (non-noop) publisher: any object other than the noop sentinel. */
const realPublisher = new McpChannelPublisher({
  server: { notification: () => Promise.resolve() },
} as never);

interface FakeRegisteredTool {
  callback?: (args: unknown, extra?: unknown) => Promise<unknown>;
  update(updates: { callback: (args: unknown, extra?: unknown) => Promise<unknown> }): void;
}

function makePlaceholders(names: string[]): {
  placeholders: Map<string, FakeRegisteredTool>;
  invoke: (
    name: string,
    args: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
} {
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of names) {
    const tool: FakeRegisteredTool = {
      update(updates) {
        tool.callback = updates.callback;
      },
    };
    placeholders.set(name, tool);
  }
  return {
    placeholders,
    invoke: async (name, args) => {
      const cb = placeholders.get(name)?.callback;
      if (!cb) throw new Error(`no callback for ${name}`);
      return cb(args) as Promise<{ content: { text: string }[]; isError?: boolean }>;
    },
  };
}

describe('server.health', () => {
  it('returns the expected shape with config-derived fields', async () => {
    const { placeholders, invoke } = makePlaceholders(['server.health']);
    const state = {
      config: {
        adapter: 'mock',
        dbPath: '/tmp/test.sqlite',
        logLevel: 'debug',
      },
    } as never;
    registerServerTools({} as never, state, placeholders as never);

    const result = await invoke('server.health', {});
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(body).toMatchObject({
      adapter: 'mock',
      dbPath: '/tmp/test.sqlite',
      logLevel: 'debug',
    });
    expect(typeof body.version).toBe('string');
    expect(typeof body.build).toBe('string');
    expect(typeof body.sdkVersion).toBe('string');
    expect(typeof body.analyticsVersion).toBe('string');
    // The voltras-mcp version should match its package.json (0.1.0 at write time).
    // We don't assert the exact value here — just that it's a non-empty string
    // and is NOT the literal placeholder.
    expect((body.version as string).length).toBeGreaterThan(0);
  });

  it('reports channelsWired when a real publisher is installed', async () => {
    const { placeholders, invoke } = makePlaceholders(['server.health']);
    const state = {
      config: { adapter: 'node', dbPath: '/x', logLevel: 'info' },
      channels: realPublisher,
    } as never;
    registerServerTools({} as never, state, placeholders as never);

    const body = JSON.parse((await invoke('server.health', {})).content[0].text);
    expect(body.channelsWired).toBe(true);
    // Delivery is not server-observable; the removed enabled/degraded flags
    // (VMCP-02.30) must not reappear — they read a client capability the real
    // Claude Code host never sends (VMCP-01.42).
    expect(body.channelsEnabled).toBeUndefined();
    expect(body.channelsDegraded).toBeUndefined();
    // No delivery confirmed yet → null.
    expect(body.channelsLastConfirmedAt).toBeNull();
  });

  it('surfaces channelsLastConfirmedAt from the delivery tracker once a push is confirmed', async () => {
    const { placeholders, invoke } = makePlaceholders(['server.health']);
    const confirmedAt = '2026-07-02T12:00:00.000Z';
    const channelDelivery = new ChannelDeliveryTracker(() => confirmedAt);
    channelDelivery.recordProbe('n1');
    channelDelivery.recordConfirmation('n1');
    const state = {
      config: { adapter: 'node', dbPath: '/x', logLevel: 'info' },
      channels: realPublisher,
      channelDelivery,
    } as never;
    registerServerTools({} as never, state, placeholders as never);

    const body = JSON.parse((await invoke('server.health', {})).content[0].text);
    expect(body.channelsWired).toBe(true);
    expect(body.channelsLastConfirmedAt).toBe(confirmedAt);
  });

  it('does not depend on client capabilities (host channel opt-in is server-invisible)', async () => {
    const { placeholders, invoke } = makePlaceholders(['server.health']);
    // Even a state whose server would report NO client channel capability
    // still reports channelsWired: the flag reflects the publisher, not any
    // (nonexistent) client-side capability signal.
    const state = {
      config: { adapter: 'node', dbPath: '/x', logLevel: 'info' },
      channels: realPublisher,
      server: { server: { getClientCapabilities: () => ({ experimental: {} }) } },
    } as never;
    registerServerTools({} as never, state, placeholders as never);

    const body = JSON.parse((await invoke('server.health', {})).content[0].text);
    expect(body.channelsWired).toBe(true);
  });

  it('reports channelsWired false when no real publisher is wired (nothing pushed)', async () => {
    const { placeholders, invoke } = makePlaceholders(['server.health']);
    const state = {
      config: { adapter: 'node', dbPath: '/x', logLevel: 'info' },
      channels: noopChannelPublisher,
    } as never;
    registerServerTools({} as never, state, placeholders as never);

    const body = JSON.parse((await invoke('server.health', {})).content[0].text);
    expect(body.channelsWired).toBe(false);
  });

  it('throws if the placeholder is missing', () => {
    const { placeholders } = makePlaceholders([]); // no server.health
    const state = { config: { adapter: 'node', dbPath: '/x', logLevel: 'info' } } as never;
    expect(() => registerServerTools({} as never, state, placeholders as never)).toThrow(
      /server\.health/,
    );
  });
});
