// What the action layer may run (VW-502).
//
// These are the tests that stop the allowlist rotting open. Two of them are
// about what is ABSENT, which is the half a reviewer cannot check by reading
// the table.

import { describe, expect, it } from 'vitest';

import {
  ACTION_ALLOWLIST,
  DEFERRED_ACTIONS,
  DEVICE_NAMESPACES,
  STORE_ONLY_NAMESPACES,
  actionEntry,
  toolNamespace,
} from '../allowlist.js';
import { CORE_TOOL_NAMES } from '../../tool-registry.js';

const ENTRIES = Object.entries(ACTION_ALLOWLIST);

describe('the allowlist', () => {
  it('names only tools that exist', () => {
    const known = new Set<string>(CORE_TOOL_NAMES);
    for (const [name, entry] of ENTRIES) {
      expect(known.has(entry.tool), `${name} names a tool that does not exist`).toBe(true);
    }
  });

  it('names only store-writing namespaces', () => {
    // A NAMESPACE check, not a proof that a handler touches no device. It
    // guards against the table rotting open as tools are added; the semantic
    // claim rests on reading the handlers, which is a review step.
    for (const [name, entry] of ENTRIES) {
      const namespace = toolNamespace(entry.tool);
      expect(
        (STORE_ONLY_NAMESPACES as readonly string[]).includes(namespace),
        `${name} is in the ${namespace} namespace, which is not store-only`,
      ).toBe(true);
    }
  });

  it('names no device namespace at all', () => {
    for (const [name, entry] of ENTRIES) {
      expect(
        (DEVICE_NAMESPACES as readonly string[]).includes(toolNamespace(entry.tool)),
        `${name} reaches the device and must not be on a touch surface`,
      ).toBe(false);
    }
  });

  it('carries only W1 and W2 — W3 needs the lease and W4 is never on a touch surface', () => {
    for (const [name, entry] of ENTRIES) {
      expect(['W1', 'W2'], `${name} is tier ${entry.tier}`).toContain(entry.tier);
    }
  });

  it('gives every entry a reason a reviewer can check the tier against', () => {
    for (const [name, entry] of ENTRIES) {
      expect(entry.why.length, `${name} has no stated reason`).toBeGreaterThan(20);
    }
  });

  it('refuses a name it does not hold, including one reached through the prototype', () => {
    expect(actionEntry('device.set_weight')).toBeUndefined();
    expect(actionEntry('goal.retire')).toBeUndefined();
    // `Object.prototype` members are not allowlist entries, however they are asked for.
    expect(actionEntry('toString')).toBeUndefined();
    expect(actionEntry('constructor')).toBeUndefined();
  });

  it('keeps the deferred names out of the allowlist and says why', () => {
    for (const [name, reason] of Object.entries(DEFERRED_ACTIONS)) {
      expect(ACTION_ALLOWLIST[name]).toBeUndefined();
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
