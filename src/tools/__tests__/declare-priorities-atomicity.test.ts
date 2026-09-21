// VW-536: two `goal.declare_priorities` calls at once. A re-declaration folds into the row it
// names and a whole-body metric carries one live priority, but both rules were checked against
// a list read before the write: two calls that each saw no row minted two. Every case runs in
// the two variants of `store-concurrency.test.ts`: one store instance, and two instances on one
// temp file.
//
// Every value is synthetic.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ServerState } from '../../state/server-state.js';
import { LOCAL_USER_ID, SqliteSessionStore } from '../../store/sqlite-store.js';
import type { SessionStore } from '../../store/types.js';
import { registerGoalTools } from '../goal-tools.js';

const GOAL_TOOLS = [
  'goal.declare_priorities',
  'goal.propose_targets',
  'goal.accept_target',
  'goal.list',
  'goal.retire',
  'goal.new_chapter',
  'goal.weekly_review',
];

type Result = { isError?: boolean; content: { text: string }[] };
type Declare = (ref: string) => Promise<Result>;
type Callback = (args: unknown) => Promise<Result>;

/** `goal.declare_priorities` on one store, declaring one maintained muscle ref. */
function declarerOn(store: SessionStore): Declare {
  const callbacks = new Map<string, Callback>();
  const placeholders = new Map(
    GOAL_TOOLS.map((name) => [
      name,
      { update: (u: { callback: Callback }) => callbacks.set(name, u.callback) },
    ]),
  );
  const state = { store, exercises: { list: () => [], getById: () => undefined } };
  registerGoalTools({} as never, state as unknown as ServerState, placeholders as never);
  return (ref) =>
    callbacks.get('goal.declare_priorities')!({
      items: [{ kind: 'muscle', ref, level: 'maintain' }],
      horizonWeeks: 8,
    });
}

let dir: string | undefined;
const opened: SessionStore[] = [];

function storePair(connections: 1 | 2): [SessionStore, SessionStore] {
  dir ??= mkdtempSync(join(tmpdir(), 'vmcp-declare-'));
  const open = (): SessionStore => {
    const store = SqliteSessionStore.open(join(dir!, 'store.sqlite'));
    opened.push(store);
    return store;
  };
  const a = open();
  return [a, connections === 1 ? a : open()];
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function errorCode(result: Result): string {
  return result.isError === true
    ? (JSON.parse(result.content[0].text) as { code: string }).code
    : 'ok';
}

describe.each([1, 2] as const)('goal.declare_priorities with %i connection(s) (VW-536)', (n) => {
  it('folds two declarations of one ref into one row', async () => {
    const [a, b] = storePair(n);

    await Promise.all([declarerOn(a)('chest'), declarerOn(b)('chest')]);

    expect(await b.listPriorities(LOCAL_USER_ID)).toHaveLength(1);
  });

  it('keeps one live priority for a whole-body metric declared two ways at once', async () => {
    const [a, b] = storePair(n);

    const results = await Promise.all([declarerOn(a)('bodyweight'), declarerOn(b)('Bodyweight')]);

    expect(results.map(errorCode).sort()).toEqual(['GOAL_WHOLE_BODY_PRIORITY_EXISTS', 'ok']);
    expect(await b.listPriorities(LOCAL_USER_ID)).toHaveLength(1);
  });
});
