// The persona sweep's checks (scripts/lib/sweep-checks.mjs, VW-945) on planted
// strings: each test names the mutation it catches.
import { describe, expect, it } from 'vitest';

import {
  READ_TOOLS,
  WRITE_TOOL_NAME,
  checkHttpStatus,
  checkPage,
  checkPageExpectations,
  checkToolResult,
  findBadTokens,
  findBadTokensInPayload,
  findLbLeaks,
  findWeekOfMismatch,
  localMondayOf,
} from '../../scripts/lib/sweep-checks.mjs';

describe('the kg page check', () => {
  it('flags a pound reading left on a kg page', () => {
    // Mutation caught: a regex that drops `lb` and only matches `lbs`.
    expect(findLbLeaks('Best 8 x 106 lb')).toHaveLength(1);
    expect(findLbLeaks('Top set 40 lbs')).toHaveLength(1);
  });

  it('passes a kilogram reading', () => {
    expect(findLbLeaks('1.2 kg')).toEqual([]);
  });

  it('runs only when the page is set to kg', () => {
    const page = { persona: 'steady', route: '#/', text: 'Best 8 x 106 lb', expectedMonday: 'x' };
    expect(checkPage({ ...page, unit: 'lb' })).toEqual([]);
    expect(checkPage({ ...page, unit: 'kg' }).map((f) => f.kind)).toEqual(['lb-in-kg']);
  });
});

describe('the bad-token check', () => {
  it('flags NaN beside punctuation but not inside a word', () => {
    // Mutation caught: a dropped word boundary, which would flag "Nancy".
    expect(findBadTokens('Rate NaN%')).toHaveLength(1);
    expect(findBadTokens('Nancy trained today')).toEqual([]);
  });

  it('flags every raw value the formatter can leak', () => {
    const page = 'undefined Infinity [object Object] Invalid Date null kg';
    expect(findBadTokens(page).map((f) => f.detail.split(':')[0])).toEqual([
      'undefined',
      'Infinity',
      '[object Object]',
      'Invalid Date',
      'null',
    ]);
  });

  it('reads JSON nulls as absent values and a "null kg" string as a leak', () => {
    expect(findBadTokensInPayload('{"weight":null,"note":"null on purpose"}')).toEqual([]);
    expect(findBadTokensInPayload('{"label":"null kg"}')).toHaveLength(1);
    expect(findBadTokensInPayload('{"label":"NaN%"}')).toHaveLength(1);
  });

  it('checks a non-JSON tool reply as prose', () => {
    expect(findBadTokensInPayload('# Weekly\nVolume: undefined sets')).toHaveLength(1);
  });
});

describe('the persona expectation table', () => {
  const table = {
    fresh: { routes: { '#/summary': { mustShow: ['No sessions yet'] } } },
    steady: { routes: { '*': { mustNotShow: ['No priorities declared'] } } },
  };

  it('reports a miss with its persona and route', () => {
    const findings = checkPageExpectations(
      { persona: 'fresh', route: '#/summary', unit: 'lb', text: 'HTTP 404' },
      table,
    );
    expect(findings).toEqual([
      {
        kind: 'expectation',
        persona: 'fresh',
        route: '#/summary',
        detail: 'missing "No sessions yet"',
      },
    ]);
  });

  it('applies a star rule on every route', () => {
    const findings = checkPageExpectations(
      { persona: 'steady', route: '#/goals', unit: 'lb', text: 'No priorities declared' },
      table,
    );
    expect(findings.map((f) => [f.persona, f.route, f.detail])).toEqual([
      ['steady', '#/goals', 'shows "No priorities declared"'],
    ]);
  });

  it('allows a 404 only where the persona lists it', () => {
    const allowing = { fresh: { allow404: ['/api/session-summary/latest'], routes: {} } };
    const at = (persona: string, endpoint: string, status: number) =>
      checkHttpStatus({ persona, endpoint, status }, allowing);
    expect(at('fresh', '/api/session-summary/latest', 404)).toEqual([]);
    expect(at('fresh', '/api/muscle-plan', 404)).toHaveLength(1);
    expect(at('steady', '/api/session-summary/latest', 404)).toHaveLength(1);
    expect(at('fresh', '/api/goals', 500)).toHaveLength(1);
  });
});

describe('the week check', () => {
  it('takes the Monday of the week a Sunday night falls in', () => {
    expect(localMondayOf(new Date(2026, 9, 11, 23, 30))).toBe('2026-10-05');
    expect(localMondayOf(new Date(2026, 9, 12, 5, 0))).toBe('2026-10-12');
  });

  it('flags a "Week of" heading on any other date', () => {
    expect(findWeekOfMismatch('Week of 2026-10-05', '2026-10-05')).toEqual([]);
    expect(findWeekOfMismatch('Week of 2026-10-12', '2026-10-05')).toHaveLength(1);
  });
});

describe('the read-tool allowlist', () => {
  it('names no tool that writes', () => {
    // Mutation caught: adding a write such as goal.declare_priorities to the sweep.
    const writes = READ_TOOLS.map((tool) => tool.name).filter((name) => WRITE_TOOL_NAME.test(name));
    expect(writes).toEqual([]);
  });

  it('recognises the writes and the gated tools', () => {
    for (const name of [
      'goal.declare_priorities',
      'session.end',
      'plan.program.create',
      'profile.log_bodyweight',
      'debug.recent_events',
      'mock.configure',
    ]) {
      expect(WRITE_TOOL_NAME.test(name), name).toBe(true);
    }
  });

  it('counts a coded refusal as an answer and an uncoded error as a finding', () => {
    const refusal = '{"code":"NO_PROGRAM_FOUND","message":"No training programs exist."}';
    const where = { persona: 'fresh', tool: 'plan.next_workout', isError: true };
    expect(checkToolResult({ ...where, text: refusal })).toEqual([]);
    expect(checkToolResult({ ...where, text: 'Cannot read properties' })).toHaveLength(1);
  });
});
