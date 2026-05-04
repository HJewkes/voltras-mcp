// Tests for mock.* tool registration (Wave 3E / Task 14).
//
// As of @voltras/node-sdk@0.3.0:
//   - `MockBLEAdapter` does NOT expose a public `configure()` method (only the
//     constructor accepts `MockBLEConfig`).
//   - `MockBLEAdapter` does NOT expose a public `injectError()` API.
//   - `VoltraManager` does NOT expose a public `getAdapter()` accessor.
//
// Until the SDK exposes these surfaces, both tools return a structured
// NOT_IMPLEMENTED error. These tests assert that contract; when the SDK
// gains the missing methods, this test file is the right place to flip
// the assertions to "spy was called" expectations.
//
// AC-09 / EC-09: when `config.adapter === 'node'` the mock placeholders are
// removed by `runServer` in `src/server.ts`; `registerMockTools` is never
// called. Because that gating lives in `server.ts` (not under test here),
// this file documents — but does not re-execute — the gate. The dedicated
// server-lifecycle test owns AC-09/EC-09 verification end-to-end.
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

class FakeVoltraSDKError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VoltraSDKError';
    this.code = code;
  }
}

vi.mock('@voltras/node-sdk', () => ({
  VoltraSDKError: FakeVoltraSDKError,
  // Keep MockBLEAdapter / VoltraManager imports cheap if the module ever
  // pulls them transitively — none of the tools below need them at runtime.
  MockBLEAdapter: class {},
  VoltraManager: class {},
  VoltraClient: class {},
}));

const { registerMockTools } = await import('../mock-tools.js');

interface FakeRegisteredTool {
  name: string;
  callback: (args: unknown) => unknown;
  updated: boolean;
  removed: boolean;
  update: (updates: { callback: (args: unknown) => unknown }) => void;
  remove: () => void;
}

function createPlaceholders(names: readonly string[]): {
  placeholders: Map<string, FakeRegisteredTool>;
  byName: Record<string, FakeRegisteredTool>;
} {
  const byName: Record<string, FakeRegisteredTool> = {};
  const placeholders = new Map<string, FakeRegisteredTool>();
  for (const name of names) {
    const tool: FakeRegisteredTool = {
      name,
      callback: () => {
        throw new Error(`placeholder ${name} not replaced`);
      },
      updated: false,
      removed: false,
      update: ({ callback }) => {
        tool.callback = callback;
        tool.updated = true;
      },
      remove: () => {
        tool.removed = true;
      },
    };
    byName[name] = tool;
    placeholders.set(name, tool);
  }
  return { placeholders, byName };
}

// Minimal fake McpServer — registerMockTools should NOT call .tool() because
// it only updates pre-registered placeholders.
const fakeServer = {
  tool: vi.fn(() => {
    throw new Error('registerMockTools must not call server.tool()');
  }),
};

// Minimal fake state — registerMockTools should not need any field today
// (NOT_IMPLEMENTED handlers don't reach into state.manager).
const fakeState = {} as never;

describe('registerMockTools', () => {
  it('hot-swaps the mock.configure and mock.inject_error placeholders', () => {
    const { placeholders, byName } = createPlaceholders(['mock.configure', 'mock.inject_error']);

    registerMockTools(fakeServer as never, fakeState, placeholders as never);

    expect(byName['mock.configure'].updated).toBe(true);
    expect(byName['mock.inject_error'].updated).toBe(true);
    expect(byName['mock.configure'].removed).toBe(false);
    expect(byName['mock.inject_error'].removed).toBe(false);
    expect(fakeServer.tool).not.toHaveBeenCalled();
  });

  it('mock.configure validates input via the schema and returns NOT_IMPLEMENTED on valid input', async () => {
    const { placeholders, byName } = createPlaceholders(['mock.configure', 'mock.inject_error']);
    registerMockTools(fakeServer as never, fakeState, placeholders as never);

    const result = (await byName['mock.configure'].callback({
      deviceName: 'VTR-MOCK',
      weight: 50,
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as {
      code: string;
      message: string;
    };
    expect(parsed.code).toBe('NOT_IMPLEMENTED');
    expect(parsed.message).toMatch(/configure/i);
  });

  it('mock.configure returns INVALID_INPUT for bad input rather than NOT_IMPLEMENTED', async () => {
    const { placeholders, byName } = createPlaceholders(['mock.configure', 'mock.inject_error']);
    registerMockTools(fakeServer as never, fakeState, placeholders as never);

    const result = (await byName['mock.configure'].callback({
      weight: 'heavy',
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('INVALID_INPUT');
  });

  it('mock.inject_error validates input via the schema and returns NOT_IMPLEMENTED on valid input', async () => {
    const { placeholders, byName } = createPlaceholders(['mock.configure', 'mock.inject_error']);
    registerMockTools(fakeServer as never, fakeState, placeholders as never);

    const result = (await byName['mock.inject_error'].callback({
      type: 'disconnect',
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as {
      code: string;
      message: string;
    };
    expect(parsed.code).toBe('NOT_IMPLEMENTED');
    expect(parsed.message).toMatch(/inject/i);
  });

  it('mock.inject_error rejects unknown error categories with INVALID_INPUT', async () => {
    const { placeholders, byName } = createPlaceholders(['mock.configure', 'mock.inject_error']);
    registerMockTools(fakeServer as never, fakeState, placeholders as never);

    const result = (await byName['mock.inject_error'].callback({
      type: 'meltdown',
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('INVALID_INPUT');
  });

  it('throws if either expected placeholder is missing — caller contract', () => {
    // Empty map: caller forgot to register placeholders, or runServer
    // accidentally removed them in node mode and still called this fn.
    const { placeholders } = createPlaceholders([]);

    expect(() => registerMockTools(fakeServer as never, fakeState, placeholders as never)).toThrow(
      /mock\..*placeholder/i,
    );
  });

  // Sanity check that the schema imported by mock-tools.ts is the same
  // surface mock.ts exports — guards against accidental drift.
  it('imports the canonical mock schemas (sanity)', async () => {
    const mod = await import('../../schemas/mock.js');
    expect(mod.MockConfigureInput).toBeInstanceOf(z.ZodObject);
    expect(mod.MockInjectErrorInput).toBeInstanceOf(z.ZodObject);
  });
});
