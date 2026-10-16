// @vitest-environment happy-dom
//
// The check-in page's review step driven end to end in a DOM (VW-896): `CheckinPage` mounted
// with `react-dom/client` and a fake `post` that replays like the action route (the same id with
// the same input returns the stored outcome, a stored refusal included). The static render tests
// cannot see a state machine, so this is what proves a refused answer re-enters the review under
// a new id instead of leaving the page on "Reading this week...".

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionRefusedError } from '../spa/api-client.js';
import { CheckinPage, type Post } from '../spa/checkin/CheckinPage.js';
import type { ReviewResult } from '../spa/checkin/checkin-model.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Node 25 ships its own global `localStorage`, unusable without a file flag, and it
// shadows the DOM one; the store reads it at import, so this runs before any import.
vi.hoisted(() => {
  if (typeof globalThis.localStorage?.getItem === 'function') return;
  const items = new Map<string, string>();
  const storage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
});

const FIRST_ADVISORY = 'First advisory: hold calories steady.';
const SECOND_ADVISORY = 'Second advisory: add a little on training days.';

const open = (advisory: string): ReviewResult => ({
  outcome: 'proposal',
  advisory,
  levers: [],
  notes: [],
  proposal: { userResponse: null },
});

const answered = (userResponse: string): ReviewResult => ({
  outcome: 'proposal',
  advisory: null,
  levers: [],
  notes: [],
  proposal: { userResponse },
});

interface Call {
  tool: string;
  input: Record<string, unknown>;
  actionId: string;
}

/** Plays `script` for the review calls in order and stores every outcome under its id. */
function replayingPost(script: (() => ReviewResult | Error)[]): { post: Post; calls: Call[] } {
  const calls: Call[] = [];
  const stored = new Map<string, { key: string; outcome: unknown }>();
  const post = (async (tool: string, input: unknown, meta?: { actionId?: string }) => {
    const actionId = meta?.actionId ?? '';
    const key = JSON.stringify(input);
    calls.push({ tool, input: input as Record<string, unknown>, actionId });
    const held = stored.get(actionId);
    if (held !== undefined && held.key !== key) throw new Error('action_id_reused');
    const outcome = held?.outcome ?? (tool === 'goal.weekly_review' ? script.shift()?.() : {});
    stored.set(actionId, { key, outcome });
    if (outcome instanceof Error) throw outcome;
    return { ok: true, action: tool, actionId, replayed: held !== undefined, result: outcome };
  }) as Post;
  return { post, calls };
}

const refusal = (code: string): Error =>
  new ActionRefusedError({ code, result: null, status: 400, actionId: 'x' });

let container: HTMLDivElement;
let root: Root;

async function inAct(run: () => unknown): Promise<void> {
  await act(async () => {
    await run();
  });
}

function button(label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find(
    (el) => el.textContent === label,
  );
  if (found === undefined) throw new Error(`no "${label}" button in: ${container.textContent}`);
  return found;
}

async function press(label: string): Promise<void> {
  await inAct(() => button(label).click());
}

/** Mounts the page and skips to the review step, where the entry call runs. */
async function openReview(post: Post): Promise<void> {
  await inAct(() => root.render(createElement(CheckinPage, { post })));
  await press('Skip');
  await press('Skip');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await inAct(() => root.unmount());
  container.remove();
});

describe('the check-in review in a DOM', () => {
  it('re-enters under a new id when the answer finds no open advisory', async () => {
    const { post, calls } = replayingPost([
      () => open(FIRST_ADVISORY),
      () => refusal('NO_OPEN_ADVISORY'),
      () => open(SECOND_ADVISORY),
    ]);
    await openReview(post);
    expect(container.textContent).toContain(FIRST_ADVISORY);

    await press('Accept');

    expect(container.textContent).toContain(SECOND_ADVISORY);
    const entries = calls.filter(
      (c) => c.tool === 'goal.weekly_review' && !('response' in c.input),
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]!.actionId).not.toBe(entries[0]!.actionId);

    await press('Decline');
    expect(container.textContent).toContain('Weekly review: declined');
    const answers = calls.filter((c) => 'response' in c.input);
    expect(answers[1]!.actionId).not.toBe(answers[0]!.actionId);
  });

  it('shows the standing answer when the advisory was already answered', async () => {
    const { post } = replayingPost([
      () => open(FIRST_ADVISORY),
      () => refusal('ADVISORY_ALREADY_ANSWERED'),
      () => answered('accepted'),
    ]);
    await openReview(post);

    await press('Decline');

    expect(container.textContent).toContain('All done');
    expect(container.textContent).toContain('Weekly review: accepted (already answered)');
  });

  it('shows a server invalid_input on the review entry instead of reading forever', async () => {
    const { post } = replayingPost([
      () =>
        new ActionRefusedError({ code: 'invalid_input', result: null, status: 400, actionId: 'x' }),
    ]);
    await openReview(post);

    expect(container.textContent).toContain('invalid_input');
    expect(container.textContent).not.toContain('Reading this week');
  });
});
