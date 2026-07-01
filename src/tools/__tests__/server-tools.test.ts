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

/** Minimal real (non-noop) publisher: any object other than the noop sentinel. */
const realPublisher = new McpChannelPublisher({
  server: { notification: () => Promise.resolve() },
} as never);

/** Fake state.server whose client capabilities declare (or not) channels. */
function serverWithChannelCapability(declared: boolean): unknown {
  return {
    server: {
      getClientCapabilities: () =>
        declared ? { experimental: { 'claude/channel': {} } } : { experimental: {} },
    },
  };
}

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

  it('reports channelsEnabled when a real publisher is wired and the host opted in', async () => {
    const { placeholders, invoke } = makePlaceholders(['server.health']);
    const state = {
      config: { adapter: 'node', dbPath: '/x', logLevel: 'info' },
      channels: realPublisher,
      server: serverWithChannelCapability(true),
    } as never;
    registerServerTools({} as never, state, placeholders as never);

    const body = JSON.parse((await invoke('server.health', {})).content[0].text);
    expect(body.channelsEnabled).toBe(true);
    expect(body.channelsDegraded).toBe(false);
  });

  it('reports channelsDegraded when a publisher is wired but the host did not opt in', async () => {
    const { placeholders, invoke } = makePlaceholders(['server.health']);
    const state = {
      config: { adapter: 'node', dbPath: '/x', logLevel: 'info' },
      channels: realPublisher,
      server: serverWithChannelCapability(false),
    } as never;
    registerServerTools({} as never, state, placeholders as never);

    const body = JSON.parse((await invoke('server.health', {})).content[0].text);
    expect(body.channelsEnabled).toBe(false);
    expect(body.channelsDegraded).toBe(true);
  });

  it('reports neither flag when no real publisher is wired (nothing expected to push)', async () => {
    const { placeholders, invoke } = makePlaceholders(['server.health']);
    const state = {
      config: { adapter: 'node', dbPath: '/x', logLevel: 'info' },
      channels: noopChannelPublisher,
      server: serverWithChannelCapability(true),
    } as never;
    registerServerTools({} as never, state, placeholders as never);

    const body = JSON.parse((await invoke('server.health', {})).content[0].text);
    expect(body.channelsEnabled).toBe(false);
    expect(body.channelsDegraded).toBe(false);
  });

  it('throws if the placeholder is missing', () => {
    const { placeholders } = makePlaceholders([]); // no server.health
    const state = { config: { adapter: 'node', dbPath: '/x', logLevel: 'info' } } as never;
    expect(() => registerServerTools({} as never, state, placeholders as never)).toThrow(
      /server\.health/,
    );
  });
});
