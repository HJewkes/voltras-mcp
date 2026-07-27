// Drift guards for the canonical tool surface (VMCP-01.60).
//
// The point of these tests is that the READ/WRITE table cannot quietly fall
// behind the tool list. `Record<ToolName, ToolAccess>` already makes tsc reject
// a MISSING entry; what tsc cannot catch is a STALE entry for a tool that was
// renamed or removed, or a new tool registered somewhere other than
// CORE_TOOL_NAMES. Both are checked here.
//
// The classification itself is a judgement call per tool, so these tests
// deliberately do not re-assert every verdict — that would just restate the
// table. They assert the shape, plus the two invariants that actually matter
// for the write-lease: every device mutation is `write`, and the tools an
// observer session depends on stay `read`.

import { describe, it, expect } from 'vitest';
import {
  CORE_TOOL_NAMES,
  MOCK_TOOL_NAMES,
  TOOL_ACCESS,
  toolAccess,
  type ToolName,
} from '../tool-registry.js';

const ALL_TOOL_NAMES: readonly ToolName[] = [...CORE_TOOL_NAMES, ...MOCK_TOOL_NAMES];

describe('tool registry', () => {
  it('classifies every tool exactly once, with no stale entries', () => {
    const classified = Object.keys(TOOL_ACCESS).sort();
    expect(classified).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('has no duplicate names across the core and mock lists', () => {
    expect(new Set(ALL_TOOL_NAMES).size).toBe(ALL_TOOL_NAMES.length);
  });

  it('returns undefined for an unknown tool rather than a default class', () => {
    // A typo must not silently resolve to 'read' and skip the lease check.
    expect(toolAccess('device.set_wieght')).toBeUndefined();
    expect(toolAccess('')).toBeUndefined();
  });

  it('classifies every device mutation as write', () => {
    const deviceMutators = CORE_TOOL_NAMES.filter(
      (name) => name.startsWith('device.') && name !== 'device.get_state',
    );
    for (const name of deviceMutators) {
      expect(toolAccess(name), `${name} must be write — it drives the radio`).toBe('write');
    }
  });

  it('keeps the observer surface readable without a lease', () => {
    // These are what a non-lease-holding session needs to be useful: watching
    // the live set, reading history, and checking server state. If one of these
    // ever flips to 'write', an observer session goes blind.
    const observerSurface = [
      'device.get_state',
      'set.live_metrics',
      'set.get',
      'session.get',
      'session.list',
      'metrics.compute',
      'server.health',
    ] as const;
    for (const name of observerSurface) {
      expect(toolAccess(name), `${name} must stay readable for observers`).toBe('read');
    }
  });
});
