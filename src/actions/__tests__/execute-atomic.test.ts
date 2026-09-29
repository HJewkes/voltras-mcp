// The audited path is one transaction (VW-659, VW-512 S3).
//
// The claim, the handler's writes and the completion commit together or not at all, and a
// handler that reports an error leaves nothing behind but its error row. Each case writes a
// body-weight reading from the handler, so "no handler write" is a read of that series.
//
// In-memory store, synthetic rows.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  executeAudited,
  hashInput,
  type ActionStore,
  type AuditedWrite,
  type HandlerOutcome,
} from '../execute.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { openTestStore, type SessionStore } from '../../store/__tests__/open-test-store.js';

const AT = new Date('2026-09-19T12:00:00.000Z');

let store: SessionStore;
let runs: number;

beforeEach(() => {
  store = openTestStore();
  runs = 0;
});

afterEach(async () => {
  await store.close();
});

/** An audited body-weight write whose handler reports `ok` as asked, after writing either way. */
function bodyweightWrite(ok = true): AuditedWrite {
  return {
    actionName: 'profile.log_bodyweight',
    actionId: 'act-1',
    actor: 'user',
    surface: 'wall',
    inputHash: hashInput({ bodyweightLbs: 180 }),
    run: async (): Promise<HandlerOutcome> => {
      runs += 1;
      await store.putBodyMetric({
        userId: LOCAL_USER_ID,
        measuredAt: AT.toISOString(),
        bodyweightLbs: 180,
      });
      return ok ? { ok: true, result: { logged: true } } : { ok: false, code: 'NOPE', result: {} };
    },
  };
}

function deps(actionStore: ActionStore = store): Parameters<typeof executeAudited>[1] {
  return { store: actionStore, tools: new Map(), now: () => AT };
}

/** `store`, except that its completion writes and then throws, as a crash before commit would. */
function failingAtCompletion(): ActionStore {
  return {
    claimUiAction: (input) => store.claimUiAction(input),
    completeUiAction: async (input) => {
      await store.completeUiAction(input);
      throw new Error('injected failure before commit');
    },
    transaction: (fn) => store.transaction(fn),
  };
}

async function handlerWrites(): Promise<number> {
  return (await store.listBodyMetrics(LOCAL_USER_ID)).length;
}

describe('executeAudited runs as one transaction', () => {
  it('leaves no row and no write when it fails before commit, and a resubmit then runs', async () => {
    await expect(executeAudited(bodyweightWrite(), deps(failingAtCompletion()))).rejects.toThrow(
      'injected failure before commit',
    );

    expect(await store.getUiAction('act-1')).toBeUndefined();
    expect(await handlerWrites()).toBe(0);

    const resubmitted = await executeAudited(bodyweightWrite(), deps());

    expect(resubmitted.body).toMatchObject({ ok: true, replayed: false });
    expect(runs).toBe(2);
    expect(await store.getUiAction('act-1')).toMatchObject({ resultStatus: 'ok' });
    expect(await handlerWrites()).toBe(1);
  });

  it('runs the handler once for two concurrent submits of one id', async () => {
    const [first, second] = await Promise.all([
      executeAudited(bodyweightWrite(), deps()),
      executeAudited(bodyweightWrite(), deps()),
    ]);

    expect(runs).toBe(1);
    expect([first.body.replayed, second.body.replayed].sort()).toEqual([false, true]);
    expect(second.body.result).toEqual(first.body.result);
  });

  it('rolls back the writes of a handler that reports an error, and records the error', async () => {
    const outcome = await executeAudited(bodyweightWrite(false), deps());

    expect(outcome.body).toMatchObject({ ok: false, error: 'NOPE' });
    expect(await handlerWrites()).toBe(0);
    expect(await store.getUiAction('act-1')).toMatchObject({
      resultStatus: 'error',
      resultCode: 'NOPE',
    });
  });
});
