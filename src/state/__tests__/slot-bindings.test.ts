// Unit tests for `SlotBindingsStore` (VMCP-02.05).
//
// The store handles three concerns: roundtrip persistence across an open →
// mutate → reopen cycle, tolerant handling of missing / malformed files,
// and atomic-write semantics (the on-disk file is never left half-written).
//
// No mocks: each test runs against an isolated tmpdir so the
// filesystem-level invariants (mkdir of parent, JSON shape on disk) are
// exercised end-to-end. The bindings file is small + the tests are
// synchronous, so this is fast.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SlotBindingsStore } from '../slot-bindings.js';

describe('SlotBindingsStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slot-bindings-'));
    path = join(dir, 'nested', 'slot-bindings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty when the file does not exist (first-run path)', () => {
    const store = SlotBindingsStore.open(path);
    expect(store.list()).toEqual([]);
    expect(store.get('V-1')).toBeNull();
  });

  it('persists a binding to disk and reloads it through a fresh store instance', () => {
    const store = SlotBindingsStore.open(path);
    const bound = store.bind('V-1', 'left');
    expect(bound.deviceId).toBe('V-1');
    expect(bound.physicalSide).toBe('left');
    expect(typeof bound.boundAt).toBe('string');

    // Reopen: a fresh process would do this on bootstrap.
    const reopened = SlotBindingsStore.open(path);
    expect(reopened.get('V-1')).toEqual(bound);
    expect(reopened.list()).toHaveLength(1);
  });

  it('replaces an existing binding on rebind for the same deviceId', () => {
    const store = SlotBindingsStore.open(path);
    store.bind('V-1', 'left');
    const rebound = store.bind('V-1', 'right');
    expect(rebound.physicalSide).toBe('right');
    expect(store.list()).toHaveLength(1);
    expect(store.get('V-1')?.physicalSide).toBe('right');
  });

  it('supports two independent bindings (left + right) and reloads both', () => {
    const store = SlotBindingsStore.open(path);
    store.bind('V-L', 'left');
    store.bind('V-R', 'right');

    const reopened = SlotBindingsStore.open(path);
    expect(reopened.list()).toEqual([
      expect.objectContaining({ deviceId: 'V-L', physicalSide: 'left' }),
      expect.objectContaining({ deviceId: 'V-R', physicalSide: 'right' }),
    ]);
  });

  it('list() returns entries sorted by deviceId', () => {
    const store = SlotBindingsStore.open(path);
    store.bind('V-2', 'right');
    store.bind('V-1', 'left');
    store.bind('V-3', 'left');
    expect(store.list().map((b) => b.deviceId)).toEqual(['V-1', 'V-2', 'V-3']);
  });

  it('touch() updates lastSeen without resetting boundAt', () => {
    // Pin Date.now() to deterministic values so the two timestamps are
    // guaranteed distinct — calls within the same tick can otherwise
    // share an ms boundary and produce identical ISO strings.
    const t0 = Date.parse('2026-05-12T12:00:00.000Z');
    const t1 = Date.parse('2026-05-12T12:00:01.000Z');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      const store = SlotBindingsStore.open(path);
      const bound = store.bind('V-1', 'left');
      // `bound` may share an object reference with the in-map entry;
      // snapshot the original lastSeen string so the post-touch
      // comparison is value-vs-value, not reference.
      const originalLastSeen = bound.lastSeen;
      const originalBoundAt = bound.boundAt;
      nowSpy.mockReturnValue(t1);
      store.touch('V-1');
      const updated = store.get('V-1');
      expect(updated?.boundAt).toBe(originalBoundAt);
      expect(updated?.lastSeen).toBe(new Date(t1).toISOString());
      expect(updated!.lastSeen).not.toBe(originalLastSeen);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('touch() is a no-op when the deviceId is unbound', () => {
    const store = SlotBindingsStore.open(path);
    store.touch('V-NOPE');
    expect(store.list()).toEqual([]);
  });

  it('remove() drops the binding and returns the removed entry', () => {
    const store = SlotBindingsStore.open(path);
    const bound = store.bind('V-1', 'left');
    const removed = store.remove('V-1');
    expect(removed).toEqual(bound);
    expect(store.get('V-1')).toBeNull();
  });

  it('remove() returns null when the deviceId is unbound', () => {
    const store = SlotBindingsStore.open(path);
    expect(store.remove('V-NOPE')).toBeNull();
  });

  it('clear() drops every binding and persists the empty state', () => {
    const store = SlotBindingsStore.open(path);
    store.bind('V-1', 'left');
    store.bind('V-2', 'right');
    store.clear();
    expect(store.list()).toEqual([]);
    const reopened = SlotBindingsStore.open(path);
    expect(reopened.list()).toEqual([]);
  });

  it('tolerates a malformed JSON file by starting empty (next write overwrites)', () => {
    // Write garbage where the store expects valid JSON.
    writeFileSync(path.replace('/nested/', '/'), 'not json at all', 'utf8');
    const flatPath = path.replace('/nested/', '/');
    const store = SlotBindingsStore.open(flatPath);
    expect(store.list()).toEqual([]);
    // The next write should succeed — store recovers cleanly.
    store.bind('V-1', 'left');
    expect(store.get('V-1')?.physicalSide).toBe('left');
  });

  it('tolerates a well-formed JSON file with the wrong shape by starting empty', () => {
    const flatPath = path.replace('/nested/', '/');
    writeFileSync(flatPath, JSON.stringify({ totally: 'wrong' }), 'utf8');
    const store = SlotBindingsStore.open(flatPath);
    expect(store.list()).toEqual([]);
  });

  it('drops individual entries with unknown physicalSide values', () => {
    const flatPath = path.replace('/nested/', '/');
    writeFileSync(
      flatPath,
      JSON.stringify({
        version: 1,
        bindings: [
          { deviceId: 'V-OK', physicalSide: 'left', boundAt: '2026-01-01T00:00:00.000Z' },
          { deviceId: 'V-BAD', physicalSide: 'middle', boundAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
      'utf8',
    );
    const store = SlotBindingsStore.open(flatPath);
    // Implementation choice: when ANY entry fails validation we drop the
    // whole file, since a partially-trusted file is hard to reason about.
    expect(store.list()).toEqual([]);
  });

  it('writes a deterministic JSON shape (version + bindings array)', () => {
    const store = SlotBindingsStore.open(path);
    store.bind('V-1', 'left');
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.bindings)).toBe(true);
    expect(parsed.bindings[0]).toMatchObject({ deviceId: 'V-1', physicalSide: 'left' });
  });

  it('creates the parent directory when it does not exist (mkdirSync recursive)', () => {
    // path is .../nested/slot-bindings.json — `nested` does not exist yet.
    const store = SlotBindingsStore.open(path);
    store.bind('V-1', 'left');
    // Reopen verifies the file landed on disk in the nested dir.
    const reopened = SlotBindingsStore.open(path);
    expect(reopened.get('V-1')?.physicalSide).toBe('left');
  });
});
