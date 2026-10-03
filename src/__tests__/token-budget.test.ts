// Unit tests for the token budget check (scripts/lib/token-budget-core.mjs, VW-831).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  TEMP_PATH_PLACEHOLDER,
  childEnv,
  compareBudgets,
  estimateTokens,
  maskPaths,
  parseBudget,
  renderBudget,
  summarize,
  toolsListRows,
} from '../../scripts/lib/token-budget-core.mjs';

const tool = (name: string, description: string) => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { slot: { type: 'string' } } },
});

const TOOLS = [
  tool('set.start', 'Start recording a new set on the active session.'),
  tool('session.end', 'End the active session and close any open set.'),
];

const repEvent = (velocity: number) =>
  JSON.stringify([{ event_type: 'rep_finalized' }, { summary: 'Rep 3 finished', velocity }]);

function budgetFor(tools: typeof TOOLS, pushTexts: string[] = [repEvent(0.412)]) {
  return {
    toolsList: toolsListRows(tools),
    journeys: [
      {
        name: 'live-workout',
        responses: summarize([{ key: 'set.start', text: '{"setId":"set-1"}' }]),
        pushEvents: summarize(pushTexts.map((text) => ({ key: 'rep_finalized', text }))),
      },
    ],
  };
}

/** The committed table as `--check` reads it: rendered, then parsed back. */
const committedFrom = (budget: ReturnType<typeof budgetFor>) => parseBudget(renderBudget(budget));

describe('token budget check', () => {
  it('passes an unchanged surface', () => {
    const committed = committedFrom(budgetFor(TOOLS));

    expect(compareBudgets(committed, budgetFor(TOOLS))).toEqual([]);
  });

  it('fails when one tool description grows by 1,000 characters', () => {
    const committed = committedFrom(budgetFor(TOOLS));
    const [first, ...rest] = TOOLS;
    const longer = [{ ...first, description: first.description + 'x'.repeat(1000) }, ...rest];

    const failures = compareBudgets(committed, budgetFor(longer));

    expect(failures.some((failure) => failure.startsWith('tools/list `set.start`'))).toBe(true);
  });

  it('fails a journey whose push events grow more than 5%', () => {
    const committed = committedFrom(budgetFor(TOOLS, [repEvent(0.412)]));

    const failures = compareBudgets(committed, budgetFor(TOOLS, Array(2).fill(repEvent(0.412))));

    expect(failures.filter((failure) => failure.startsWith('live-workout '))).toEqual([
      expect.stringMatching(/^live-workout push events: /),
      expect.stringMatching(/^live-workout total: /),
    ]);
  });

  it('fails a row the committed table has never seen', () => {
    const committed = committedFrom(budgetFor(TOOLS));

    const failures = compareBudgets(
      committed,
      budgetFor([...TOOLS, tool('set.get', 'Read a set.')]),
    );

    expect(failures).toContain('tools/list `set.get`: new row, 59 tokens');
  });
});

describe('token estimate', () => {
  it('counts a rounded value the same whatever its last digits', () => {
    expect(estimateTokens(repEvent(0.4))).toBe(estimateTokens(repEvent(10.392)));
  });

  it('counts a full-precision float above a rounded one', () => {
    expect(estimateTokens(repEvent(0.3976899801314225))).toBeGreaterThan(
      estimateTokens(repEvent(0.398)),
    );
  });

  it('counts prose at half the density of numeric JSON', () => {
    const prose = 'a'.repeat(37) + ' ' + 'b'.repeat(38);
    const numeric = JSON.stringify(Array(19).fill(1234));

    expect(estimateTokens(prose)).toBeCloseTo(20, 5);
    expect(estimateTokens(numeric)).toBeCloseTo(numeric.length / 1.9, 5);
  });
});

describe('child server env', () => {
  const parent = {
    PATH: '/usr/bin',
    NODE_OPTIONS: '--max-old-space-size=4096',
    HOME: '/parent-shell',
    VMCP_TRUECOACH_OUTBOX: '/parent-shell/outbox',
    VMCP_TRUECOACH_SUBMIT_ON_END: '1',
    VMCP_RECORD_SESSION: '1',
    VMCP_REST_TIMER: 'on',
    VOLTRAS_EFFORT_CUE: 'on',
  };

  it('never passes the outbox, the recorder or a cue switch from the parent shell', () => {
    const env = childEnv(parent, '/scratch/home', { VOLTRA_ADAPTER: 'mock' });

    expect(env).toEqual({
      PATH: '/usr/bin',
      NODE_OPTIONS: '--max-old-space-size=4096',
      HOME: '/scratch/home',
      VOLTRA_ADAPTER: 'mock',
    });
  });
});

describe('temp path masking', () => {
  it('counts a long macOS temp path the same as a short Linux one', () => {
    const health = (dir: string) => JSON.stringify({ dbPath: `${dir}/budget.sqlite` });
    const mac = '/var/folders/92/abcdefghijklmnopqrstuvwxyz0123/T/vmcp-budget-Ab12Cd';
    const linux = '/tmp/vmcp-budget-Xy34Zw';

    expect(maskPaths(health(mac), [mac])).toBe(maskPaths(health(linux), [linux]));
    expect(maskPaths(health(linux), [linux])).toContain(TEMP_PATH_PLACEHOLDER);
  });

  it('masks the longest root first, so a nested scratch dir leaves no suffix behind', () => {
    const masked = maskPaths('/tmp/vmcp-budget-Ab12Cd/home', ['/tmp', '/tmp/vmcp-budget-Ab12Cd']);

    expect(masked).toBe(`${TEMP_PATH_PLACEHOLDER}/home`);
  });
});

describe('committed docs/token-budget.md', () => {
  const text = readFileSync(join(__dirname, '../../docs/token-budget.md'), 'utf8');
  const committed = parseBudget(text);

  it('holds the tool list and the three journeys', () => {
    expect(committed.toolsList.length).toBeGreaterThan(100);
    expect(committed.journeys.map((journey) => journey.name)).toEqual([
      'live-workout',
      'sunday-sitting',
      'weekly-review',
    ]);
  });

  it('still parses once a formatter has aligned its columns', () => {
    const aligned = text.replace(/^\| `([^`]+)` \|/gm, '| `$1`    |');

    expect(parseBudget(aligned)).toEqual(committed);
  });

  it('is exactly what the generator renders, so nobody edited it by hand', () => {
    expect(renderBudget(committed)).toBe(text);
  });
});
