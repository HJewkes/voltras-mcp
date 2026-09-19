// The action layer's execute path (VW-502).
//
// The four idempotency cases are the point of this file, and each one asserts
// how many times the HANDLER ran, not only what came back: "returns the same
// answer" is not the same claim as "wrote once".
//
// Values here are synthetic.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  executeAction,
  hashInput,
  type ActionRequest,
  type ExecuteActionDeps,
} from '../execute.js';
import type { CapturedTools } from '../capture-handlers.js';
import type {
  ClaimUiActionInput,
  ClaimUiActionOutcome,
  CompleteUiActionInput,
  StoredUiAction,
} from '../../store/types.js';

const AT = new Date('2026-09-19T12:00:00.000Z');

/** In-memory `ui_actions`, with the primary key the real table relies on. */
class FakeActionStore {
  readonly rows = new Map<string, StoredUiAction>();

  claimUiAction = (input: ClaimUiActionInput): Promise<ClaimUiActionOutcome> => {
    const existing = this.rows.get(input.actionId);
    if (existing !== undefined) return Promise.resolve({ kind: 'taken', existing });
    this.rows.set(input.actionId, {
      actionId: input.actionId,
      actionName: input.actionName,
      actor: input.actor,
      surface: input.surface,
      ...(input.flowId === undefined ? {} : { flowId: input.flowId }),
      inputHash: input.inputHash,
      resultStatus: 'pending',
      createdAt: input.createdAt,
    });
    return Promise.resolve({ kind: 'claimed' });
  };

  completeUiAction = (input: CompleteUiActionInput): Promise<StoredUiAction> => {
    const row = this.rows.get(input.actionId);
    if (row === undefined) throw new Error('no such action');
    if (row.resultStatus !== 'pending') throw new Error('already completed');
    const next: StoredUiAction = {
      ...row,
      resultStatus: input.resultStatus,
      ...(input.resultCode === undefined ? {} : { resultCode: input.resultCode }),
      result: input.result,
      completedAt: input.completedAt,
    };
    this.rows.set(input.actionId, next);
    return Promise.resolve(next);
  };
}

interface Harness {
  deps: ExecuteActionDeps;
  store: FakeActionStore;
  runs: () => number;
}

/** A captured tool whose handler counts its calls and answers like a real one. */
function harness(options: { fails?: boolean; shape?: Record<string, unknown> } = {}): Harness {
  const store = new FakeActionStore();
  let runs = 0;
  const tools: CapturedTools = new Map([
    [
      'profile.log_bodyweight',
      {
        paramsShape: options.shape ?? { weightLbs: z.number(), note: z.string().optional() },
        handler: (): { content: { type: 'text'; text: string }[]; isError?: boolean } => {
          runs += 1;
          return options.fails === true
            ? {
                content: [
                  { type: 'text', text: JSON.stringify({ code: 'NOPE', message: 'refused' }) },
                ],
                isError: true,
              }
            : { content: [{ type: 'text', text: JSON.stringify({ logged: true, runs }) }] };
        },
      },
    ],
  ]);
  return { store, runs: () => runs, deps: { store, tools, now: () => AT } };
}

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    name: 'profile.log_bodyweight',
    actionId: 'act-1',
    actor: 'user',
    surface: 'wall',
    input: { weightLbs: 180 },
    ...overrides,
  };
}

describe('executeAction', () => {
  it('runs an allowlisted action and records it', async () => {
    const h = harness();
    const outcome = await executeAction(request(), h.deps);
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ ok: true, replayed: false, tier: 'W1' });
    expect(h.runs()).toBe(1);
    const row = h.store.rows.get('act-1');
    expect(row).toMatchObject({ actor: 'user', surface: 'wall', resultStatus: 'ok' });
  });

  it('refuses an unknown name with 403, not 404', async () => {
    const h = harness();
    const outcome = await executeAction(request({ name: 'device.set_weight' }), h.deps);
    expect(outcome.status).toBe(403);
    expect(outcome.body.error).toBe('action_not_allowed');
    expect(h.runs()).toBe(0);
    expect(h.store.rows.size).toBe(0);
  });

  it('refuses a W4 device tool the same way, with nothing claimed', async () => {
    const h = harness();
    for (const name of ['device.send_raw', 'device.start_guided_load', 'truecoach.import_week']) {
      const outcome = await executeAction(request({ name }), h.deps);
      expect(outcome.status).toBe(403);
    }
    expect(h.runs()).toBe(0);
  });

  it('rejects input its tool would reject, before claiming an id', async () => {
    const h = harness();
    const outcome = await executeAction(request({ input: { weightLbs: 'heavy' } }), h.deps);
    expect(outcome.status).toBe(400);
    expect(outcome.body.error).toBe('invalid_input');
    expect(h.store.rows.size).toBe(0);
  });

  it('replays the stored result for the same id and input, and writes once', async () => {
    const h = harness();
    const first = await executeAction(request(), h.deps);
    const second = await executeAction(request(), h.deps);
    expect(h.runs()).toBe(1);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.result).toEqual(first.body.result);
  });

  it('replays across a different key order, because the hash is canonical', async () => {
    const h = harness();
    await executeAction(request({ input: { weightLbs: 180, note: 'am' } }), h.deps);
    const second = await executeAction(request({ input: { note: 'am', weightLbs: 180 } }), h.deps);
    expect(second.body.replayed).toBe(true);
    expect(h.runs()).toBe(1);
  });

  it('refuses the same id when the body only gained an extra key', async () => {
    // Found in live verification. The capture gets `schema.shape`, and
    // rebuilding `z.object(shape)` loses `.strict()`, so a hash over the PARSED
    // value drops the extra key and lets this replay the first submission's
    // success. The hash is over the raw input for exactly this reason.
    const h = harness();
    await executeAction(request({ input: { weightLbs: 180 } }), h.deps);
    const second = await executeAction(
      request({ input: { weightLbs: 180, sneaky: true } }),
      h.deps,
    );
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('action_id_reused');
    expect(h.runs()).toBe(1);
  });

  it('refuses the same id with a different body, and runs nothing', async () => {
    const h = harness();
    await executeAction(request(), h.deps);
    const second = await executeAction(request({ input: { weightLbs: 999 } }), h.deps);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('action_id_reused');
    expect(h.runs()).toBe(1);
  });

  it('answers indeterminate for a row a crash left pending, and runs nothing', async () => {
    const h = harness();
    // Exactly what a process death between the handler and the completion
    // leaves behind: a claimed row that never completed.
    await h.store.claimUiAction({
      actionId: 'act-1',
      actionName: 'profile.log_bodyweight',
      actor: 'user',
      surface: 'wall',
      inputHash: hashInput({ weightLbs: 180 }),
      createdAt: AT.toISOString(),
    });
    const outcome = await executeAction(request(), h.deps);
    expect(outcome.status).toBe(409);
    expect(outcome.body.error).toBe('indeterminate');
    expect(outcome.body.message).toMatch(/do not resubmit/i);
    expect(h.runs()).toBe(0);
  });

  it('records a tool that refused, with the tool’s own code', async () => {
    const h = harness({ fails: true });
    const outcome = await executeAction(request(), h.deps);
    expect(outcome.status).toBe(400);
    expect(outcome.body.error).toBe('NOPE');
    expect(h.store.rows.get('act-1')).toMatchObject({
      resultStatus: 'error',
      resultCode: 'NOPE',
    });
  });

  it('replays a failure rather than re-running it', async () => {
    const h = harness({ fails: true });
    await executeAction(request(), h.deps);
    const second = await executeAction(request(), h.deps);
    expect(second.body.replayed).toBe(true);
    expect(second.body.error).toBe('NOPE');
    expect(h.runs()).toBe(1);
  });

  it('records a flow id so a flow can be rebuilt from the table alone', async () => {
    const h = harness();
    await executeAction(request({ flowId: 'sunday-2026-09-20' }), h.deps);
    expect(h.store.rows.get('act-1')?.flowId).toBe('sunday-2026-09-20');
  });
});

describe('hashInput', () => {
  it('is stable across key order and distinguishes different values', () => {
    expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
  });

  it('ignores an explicit undefined, which is what an absent field parses to', () => {
    expect(hashInput({ a: 1, b: undefined })).toBe(hashInput({ a: 1 }));
  });

  it('distinguishes nesting rather than flattening it', () => {
    expect(hashInput({ a: { b: 1 } })).not.toBe(hashInput({ 'a.b': 1 }));
  });
});
