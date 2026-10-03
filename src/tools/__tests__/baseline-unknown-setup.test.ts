// VW-878 regression: the unknown-setup refusal carries a steer, and the
// generic wording for unexpected errors must not replace it.

import { afterEach, describe, expect, it } from 'vitest';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ServerState } from '../../state/server-state.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';
import { registerBaselineTools } from '../baseline-tools.js';

type Callback = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

let store: SessionStore | undefined;

afterEach(async () => {
  await store?.close();
  store = undefined;
});

describe('baselines.get with an unknown setupId', () => {
  it('keeps the steer to run baselines.recalc inferSetups first', async () => {
    store = openTestStore();
    let callback: Callback | undefined;
    const placeholders = new Map<string, RegisteredTool>();
    for (const name of ['baselines.get', 'baselines.recalc']) {
      placeholders.set(name, {
        update: (updates: { callback: Callback }) => {
          if (name === 'baselines.get') callback = updates.callback;
        },
      } as unknown as RegisteredTool);
    }
    registerBaselineTools(
      undefined as unknown as McpServer,
      { store } as unknown as ServerState,
      placeholders,
    );

    const result = await callback!({ exerciseId: 'bench-press', setupId: 'setup-missing' });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text) as { code: string; message: string };
    expect(body.code).toBe('UNKNOWN_SETUP');
    expect(body.message).toContain('inferSetups');
  });
});
