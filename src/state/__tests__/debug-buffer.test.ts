// Unit tests for the RingBuffer + getDebugBuffers singleton.
//
// The ring buffer is a hot-path data structure (every onFrame callback hits
// it), so it gets a focused unit test. The singleton just verifies the
// process-wide instance is reused across calls.

import { describe, expect, it } from 'vitest';
import { RingBuffer, getDebugBuffers, _resetDebugBuffersForTest } from '../debug-buffer.js';

describe('RingBuffer', () => {
  it('returns an empty array before any push', () => {
    const buf = new RingBuffer<number>(4);
    expect(buf.recent(10)).toEqual([]);
    expect(buf.length()).toBe(0);
  });

  it('returns inserted values oldest-first when not yet full', () => {
    const buf = new RingBuffer<number>(4);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.recent(10)).toEqual([1, 2, 3]);
    expect(buf.length()).toBe(3);
  });

  it('overwrites oldest entries once capacity is exceeded', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    buf.push(5);
    expect(buf.recent(10)).toEqual([3, 4, 5]);
    expect(buf.length()).toBe(3);
  });

  it('clamps n to the current size', () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    expect(buf.recent(100)).toEqual([1, 2]);
  });

  it('returns the last N entries when buffer is full', () => {
    const buf = new RingBuffer<number>(5);
    for (let i = 1; i <= 10; i += 1) buf.push(i);
    expect(buf.recent(3)).toEqual([8, 9, 10]);
  });

  it('rejects non-positive capacity', () => {
    expect(() => new RingBuffer<number>(0)).toThrow();
    expect(() => new RingBuffer<number>(-5)).toThrow();
  });

  it('clear() drops all entries', () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.length()).toBe(0);
    expect(buf.recent(10)).toEqual([]);
  });
});

describe('getDebugBuffers', () => {
  it('returns the same singleton across calls', () => {
    _resetDebugBuffersForTest();
    const a = getDebugBuffers();
    const b = getDebugBuffers();
    expect(a).toBe(b);
    expect(a.frames).toBe(b.frames);
    expect(a.events).toBe(b.events);
  });

  it('honors VMCP_DEBUG_BUFFER_SIZE on first construction', () => {
    _resetDebugBuffersForTest();
    const prev = process.env.VMCP_DEBUG_BUFFER_SIZE;
    process.env.VMCP_DEBUG_BUFFER_SIZE = '8';
    try {
      const buffers = getDebugBuffers();
      expect(buffers.capacity).toBe(8);
    } finally {
      if (prev === undefined) delete process.env.VMCP_DEBUG_BUFFER_SIZE;
      else process.env.VMCP_DEBUG_BUFFER_SIZE = prev;
      _resetDebugBuffersForTest();
    }
  });
});
