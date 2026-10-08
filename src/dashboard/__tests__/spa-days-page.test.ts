// @vitest-environment happy-dom
//
// The `#/days` screen in a DOM (VW-847 S4). `DaysPage` is mounted with `react-dom/client` and
// driven by clicks, at wall and phone width. The first block answers from a scripted fetch, so
// each server outcome can be named; the second answers from `executeAction` with the
// boot-captured handlers on a throwaway store, so a mismatch, a re-entry, a dropped connection
// and the confirm that follows run against the real guard and the real replay of a stored id.
//
// Mock adapter, synthetic rows.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Node 25 ships its own global `localStorage`, unusable without a file flag, and it shadows
// the DOM one; the store reads it at import, so this runs before any import.
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

vi.mock('../spa/use-viewport.js', () => ({ useIsNarrowViewport: vi.fn(() => false) }));

import { captureActionHandlers, type CapturedTools } from '../../actions/capture-handlers.js';
import { executeAction } from '../../actions/execute.js';
import type { ReviewDay } from '../../analytics/session-review.js';
import { loadConfig } from '../../config.js';
import { bootstrapState, type ServerState } from '../../state/server-state.js';
import { readSessionReview, type SessionReviewPage } from '../session-review-api.js';
import { forgetWriteToken } from '../spa/api-client.js';
import { DaysPage } from '../spa/days/DaysPage.js';
import type { MarkResult } from '../spa/days/days-model.js';
import { MIN_LATCH_HOLD_MS } from '../spa/planner/mutation-latch.js';
import { useIsNarrowViewport } from '../spa/use-viewport.js';

interface SentPost {
  actionId: string;
  flowId?: string;
  flowStep?: string;
  input: Record<string, unknown>;
}

let container: HTMLDivElement;
let root: Root;
let posts: SentPost[];

async function inAct(run: () => unknown): Promise<void> {
  await act(async () => {
    await run();
  });
}

/** Let every pending fetch land and the confirm latch reopen. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await inAct(() => vi.advanceTimersByTimeAsync(MIN_LATCH_HOLD_MS));
  }
}

async function mount(): Promise<void> {
  await inAct(() => root.render(createElement(DaysPage)));
  await settle();
}

function text(): string {
  return container.textContent ?? '';
}

function radios(day: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[aria-label="Mark ${day}"] [role="radio"]`)];
}

function button(label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('button')].find(
    (el) => el.getAttribute('aria-label') === label || el.textContent === label,
  );
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await inAct(() => el.click());
  await settle();
}

async function pick(day: string, kind: 'Training' | 'Test'): Promise<void> {
  const radio = radios(day).find((el) => el.textContent === kind);
  if (radio === undefined) throw new Error(`no ${kind} radio on ${day}`);
  await click(radio);
}

async function tapBound(day: string): Promise<void> {
  await click(container.querySelector<HTMLElement>(`[aria-label="Range bound ${day}"]`)!);
}

async function pickRangeKind(kind: 'Training' | 'Test'): Promise<void> {
  const group = container.querySelector('[aria-label="Mark the range as"]')!;
  const radio = [...group.querySelectorAll<HTMLElement>('[role="radio"]')].find(
    (el) => el.textContent === kind,
  );
  await click(radio!);
}

function alertText(): string | null {
  return container.querySelector('[data-testid="days-alert"]')?.textContent ?? null;
}

function confirmDisabled(): boolean {
  return button('Confirm mark').getAttribute('aria-disabled') === 'true';
}

function marks(): SentPost[] {
  return posts.filter((p) => p.flowStep === 'mark' || p.flowStep === 'range_mark');
}

function reviewDay(day: string, over: Partial<ReviewDay> = {}): ReviewDay {
  return {
    day,
    kind: 'unreviewed',
    sessionIds: [`s-${day}`],
    exercises: [
      { name: 'Bench Press', exerciseId: 'bench', sets: 4, workingSets: 3, topLoadLbs: 135 },
    ],
    sets: 4,
    workingSets: 3,
    spanMinutes: 42,
    allEnded: true,
    planned: false,
    ...over,
  };
}

function markResult(input: Record<string, unknown>, over: Partial<MarkResult> = {}): MarkResult {
  return {
    kind: input.kind as MarkResult['kind'],
    dryRun: input.dryRun === true,
    newlyClassified: ['s1'],
    reclassified: [],
    skippedAlreadyMarked: [],
    alreadyThisKind: [],
    setsChanged: 4,
    days: [String(input.day ?? input.from)],
    rederiveFailed: [],
    ...over,
  };
}

type ActionAnswer = (post: SentPost) => Response | Promise<Response>;

const ok = (result: MarkResult): Response =>
  Response.json({ ok: true, action: 'session.mark_kind', actionId: 'x', replayed: false, result });
const refused = (code: string): Response =>
  Response.json({ ok: false, error: code, result: { message: code } }, { status: 400 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  forgetWriteToken();
  posts = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await inAct(() => root.unmount());
  container.remove();
  forgetWriteToken();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each([
  { width: 'wall', narrow: false },
  { width: 'phone', narrow: true },
])('the #/days page at $width width', ({ narrow }) => {
  let page: SessionReviewPage;
  let answer: ActionAnswer;

  beforeEach(() => {
    vi.mocked(useIsNarrowViewport).mockReturnValue(narrow);
    page = {
      days: [reviewDay('2026-09-11'), reviewDay('2026-09-10', { kind: 'mixed' })],
      unreviewedDays: 2,
    };
    answer = (post) => ok(markResult(post.input));
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/bootstrap') return Response.json({ token: 'tok' });
      if (url.startsWith('/api/session-review')) return Response.json(page);
      const post = JSON.parse(init?.body as string) as SentPost;
      posts.push(post);
      return answer(post);
    });
  });

  it('lists each day with its work and no kind preselected', async () => {
    await mount();

    expect(text()).toContain('Fri Sep 11');
    expect(text()).toContain('Bench Press · 4 sets · top 135 lb');
    expect(text()).toContain('mixed');
    for (const day of ['2026-09-11', '2026-09-10']) {
      expect(radios(day).map((el) => el.getAttribute('aria-checked'))).toEqual(['false', 'false']);
    }
    expect(posts).toEqual([]);
  });

  it('shows the dry run before any confirm, then confirms the same day', async () => {
    await mount();

    await pick('2026-09-11', 'Training');

    expect(posts).toEqual([
      expect.objectContaining({
        flowStep: 'preview',
        input: { kind: 'training', day: '2026-09-11', dryRun: true },
      }),
    ]);
    expect(text()).toContain('Mark 1 session on 1 day as training');
    expect(marks()).toEqual([]);

    await click(button('Confirm mark'));

    expect(marks()).toEqual([
      expect.objectContaining({ input: { kind: 'training', day: '2026-09-11' } }),
    ]);
    expect(container.querySelector('[data-testid="days-saved"]')?.textContent).toContain(
      'Saved: 1 session marked training',
    );
  });

  it('confirms a range with the four-list sum as expectSessions', async () => {
    answer = (post) =>
      ok(markResult(post.input, { newlyClassified: ['s1', 's2'], skippedAlreadyMarked: ['s3'] }));
    await mount();

    await click(button('Mark a range'));
    await tapBound('2026-09-11');
    await tapBound('2026-09-10');
    await pickRangeKind('Training');
    await click(button('Preview'));
    expect(text()).toContain('1 already marked test stays as it is');
    await click(button('Confirm mark'));

    expect(posts.map((p) => p.input)).toEqual([
      { kind: 'training', from: '2026-09-10', to: '2026-09-11', dryRun: true },
      { kind: 'training', from: '2026-09-10', to: '2026-09-11', expectSessions: 3 },
    ]);
  });

  it('pins the range card above the list on the wall and below it on a phone', async () => {
    await mount();

    await click(button('Mark a range'));

    const card = container.querySelector('[data-testid="range-card"]')!;
    const row = container.querySelector('[data-testid="day-row-2026-09-11"]')!;
    const cardFirst = Boolean(card.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(cardFirst).toBe(!narrow);
  });

  it('says not saved when the server does not answer, and Retry reuses the id', async () => {
    await mount();
    await pick('2026-09-11', 'Training');
    answer = () => new Response('{}', { status: 503 });

    await click(button('Confirm mark'));
    expect(alertText()).toContain('Not saved: the dashboard server did not answer');

    answer = (post) => ok(markResult(post.input));
    await click(button('Retry'));

    const [failed, retried] = marks();
    expect(retried?.actionId).toBe(failed?.actionId);
    expect(container.querySelector('[data-testid="days-saved"]')).not.toBeNull();
  });

  it('says the range changed and shows a fresh preview, never confirming on its own', async () => {
    let previews = 0;
    answer = (post) => {
      if (post.input.dryRun === true) {
        previews += 1;
        return ok(
          markResult(post.input, { newlyClassified: previews === 1 ? ['s1'] : ['s1', 's9'] }),
        );
      }
      return refused('EXPECTED_SESSIONS_MISMATCH');
    };
    await mount();
    await click(button('Mark a range'));
    await tapBound('2026-09-10');
    await tapBound('2026-09-11');
    await pickRangeKind('Test');
    await click(button('Preview'));

    await click(button('Confirm mark'));

    expect(alertText()).toContain('The range changed since the preview');
    expect(text()).toContain('Mark 2 sessions on 1 day as test');
    expect(marks()).toHaveLength(1);
    const previewIds = posts.filter((p) => p.flowStep === 'range_preview').map((p) => p.actionId);
    expect(new Set(previewIds).size).toBe(2);
  });

  it('refetches the list and says so when the day is gone', async () => {
    await mount();
    await pick('2026-09-11', 'Test');
    answer = () => refused('NOT_FOUND');
    page = { days: [reviewDay('2026-09-10')], unreviewedDays: 1 };

    await click(button('Confirm mark'));

    expect(alertText()).toContain('That day is no longer there');
    expect(container.querySelector('[data-testid="day-row-2026-09-11"]')).toBeNull();
  });

  it('shows an unknown refusal by its code rather than a blank state', async () => {
    answer = () => refused('SOMETHING_NEW');
    await mount();

    await pick('2026-09-11', 'Training');

    expect(alertText()).toContain('The dashboard refused that (SOMETHING_NEW)');
  });

  it('keeps Confirm off when the preview would change nothing', async () => {
    answer = (post) => ok(markResult(post.input, { newlyClassified: [], alreadyThisKind: ['s1'] }));
    await mount();

    await pick('2026-09-11', 'Training');

    expect(text()).toContain('No new sessions to mark as training');
    expect(confirmDisabled()).toBe(true);
  });

  it('flips a mixed day only behind its own preview naming the count', async () => {
    answer = (post) =>
      ok(
        markResult(
          post.input,
          post.input.reclassify === true
            ? { newlyClassified: ['s1'], reclassified: ['s2'] }
            : { skippedAlreadyMarked: ['s2'] },
        ),
      );
    await mount();
    await pick('2026-09-10', 'Training');

    await click(button('Also flip the 1 marked test'));

    expect(text()).toContain('1 session will be flipped');
    expect(posts.at(-1)?.input).toEqual({
      kind: 'training',
      day: '2026-09-10',
      reclassify: true,
      dryRun: true,
    });
    expect(marks()).toEqual([]);
  });

  it('names the exercises whose baselines did not refresh', async () => {
    answer = (post) => ok(markResult(post.input, { rederiveFailed: ['bench'] }));
    await mount();
    await pick('2026-09-11', 'Training');

    await click(button('Confirm mark'));

    expect(container.querySelector('[data-testid="days-rederive-warning"]')?.textContent).toContain(
      'Saved. The baselines for Bench Press were not refreshed',
    );
  });

  it('says it could not load the days, and Retry reads them again', async () => {
    let down = true;
    vi.stubGlobal('fetch', async () =>
      down ? new Response('{}', { status: 502 }) : Response.json(page),
    );
    await mount();
    expect(alertText()).toContain('Could not load the days');

    down = false;
    await click(button('Retry'));

    expect(container.querySelector('[data-testid="day-row-2026-09-11"]')).not.toBeNull();
  });

  it('says every day is marked at zero and links back to goals', async () => {
    page = { days: [], unreviewedDays: 0 };
    await mount();

    expect(text()).toContain('Every day is marked');
    const link = container.querySelector<HTMLElement>('[role="link"]')!;
    expect(link.textContent).toBe('Back to goals');
    await click(link);
    expect(window.location.hash).toBe('#/goals');
  });
});

describe('the #/days page against the real action handlers', () => {
  const savedEnv = { ...process.env };
  let state: ServerState;
  let tools: CapturedTools;
  let failNext = false;
  let clockMs = 0;

  async function seed(id: string, day: string): Promise<void> {
    const at = `${day}T12:00:00.000Z`;
    await state.store.putSession({ id, startedAt: at, endedAt: at });
  }

  async function serveAction(init: RequestInit | undefined): Promise<Response> {
    const sent = JSON.parse(init?.body as string) as SentPost;
    posts.push(sent);
    if (failNext) {
      failNext = false;
      throw new TypeError('fetch failed');
    }
    const outcome = await executeAction(
      {
        name: 'session.mark_kind',
        actionId: sent.actionId,
        actor: 'user',
        surface: 'wall',
        input: sent.input,
        ...(sent.flowId === undefined ? {} : { flowId: sent.flowId }),
        ...(sent.flowStep === undefined ? {} : { flowStep: sent.flowStep }),
      },
      { store: state.store, tools, now: () => new Date((clockMs += 1000)) },
    );
    return new Response(JSON.stringify(outcome.body), { status: outcome.status });
  }

  beforeEach(async () => {
    process.env.VOLTRA_ADAPTER = 'mock';
    process.env.VMCP_DB_PATH = ':memory:';
    process.env.VMCP_DASHBOARD_PORT = 'off';
    vi.mocked(useIsNarrowViewport).mockReturnValue(false);
    state = await bootstrapState(loadConfig());
    tools = captureActionHandlers(state);
    failNext = false;
    clockMs = Date.parse('2026-09-16T12:00:00.000Z');
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === '/api/bootstrap') return Response.json({ token: 'tok' });
      if (url.startsWith('/api/session-review')) {
        return Response.json(
          await readSessionReview(state.store, { kind: 'unreviewed', limit: 60 }),
        );
      }
      return serveAction(init);
    });
    await seed('s1', '2026-09-10');
    await seed('s2', '2026-09-11');
  });

  afterEach(async () => {
    await state.store.close();
    process.env = { ...savedEnv };
  });

  it('runs a mismatch, a second refusal, a dropped confirm and its Retry to one saved mark', async () => {
    await mount();
    await click(button('Mark a range'));
    await tapBound('2026-09-10');
    await tapBound('2026-09-11');
    await pickRangeKind('Training');
    await click(button('Preview'));
    expect(text()).toContain('Mark 2 sessions on 2 days as training');

    await seed('s3', '2026-09-11');
    await click(button('Confirm mark'));
    expect(alertText()).toContain('The range changed since the preview');
    expect(text()).toContain('Mark 3 sessions on 2 days as training');

    await seed('s4', '2026-09-10');
    await click(button('Confirm mark'));
    expect(alertText()).toContain('The range changed since the preview');
    expect(text()).toContain('Mark 4 sessions on 2 days as training');

    failNext = true;
    await click(button('Confirm mark'));
    expect(alertText()).toContain('Not saved: the dashboard server did not answer');
    await click(button('Retry'));

    const kinds = await Promise.all(
      ['s1', 's2', 's3', 's4'].map(async (id) => (await state.store.getSession(id))?.kind),
    );
    expect(kinds).toEqual(['training', 'training', 'training', 'training']);
    expect(text()).toContain('Saved: 4 sessions marked training');
    expect(text()).toContain('Every day is marked');

    const rows = (await state.store.listUiActions()).reverse();
    expect(rows.map((r) => [r.flowStep, r.resultStatus])).toEqual([
      ['range_preview', 'ok'],
      ['range_mark', 'error'],
      ['range_preview', 'ok'],
      ['range_mark', 'error'],
      ['range_preview', 'ok'],
      ['range_mark', 'ok'],
    ]);
    expect(new Set(rows.map((r) => r.actionId)).size).toBe(rows.length);
    const [dropped, retried] = marks().slice(-2);
    expect(retried?.actionId).toBe(dropped?.actionId);
  });
});
