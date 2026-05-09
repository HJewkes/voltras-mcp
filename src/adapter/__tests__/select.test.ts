import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../config.js';

// Stub the SDK to avoid pulling in optional peer deps (react-native-ble-plx,
// noble) at unit-test time. We only need the two static factory methods used
// by selectAdapter.
const sentinelMock = { __kind: 'mock-manager' };
const sentinelNoble = { __kind: 'node-noble-manager' };
const forMockSpy = vi.fn(() => sentinelMock);
const forNodeNobleSpy = vi.fn(() => sentinelNoble);

vi.mock('@voltras/node-sdk', () => ({
  VoltraManager: {
    forMock: forMockSpy,
    forNodeNoble: forNodeNobleSpy,
  },
}));

const baseConfig = (adapter: 'mock' | 'node'): Config =>
  Object.freeze({
    adapter,
    dbPath: '/tmp/vmcp-test.sqlite',
    logLevel: 'info',
  });

// Import after vi.mock so the mock is applied.
const { selectAdapter } = await import('../select.js');

describe('selectAdapter', () => {
  beforeEach(() => {
    forMockSpy.mockClear();
    forNodeNobleSpy.mockClear();
  });

  it('returns VoltraManager.forMock() when adapter is "mock"', () => {
    const result = selectAdapter(baseConfig('mock'));
    expect(forMockSpy).toHaveBeenCalledTimes(1);
    expect(forNodeNobleSpy).not.toHaveBeenCalled();
    expect(result).toBe(sentinelMock);
  });

  it('returns VoltraManager.forNodeNoble() when adapter is "node"', () => {
    const result = selectAdapter(baseConfig('node'));
    expect(forNodeNobleSpy).toHaveBeenCalledTimes(1);
    expect(forMockSpy).not.toHaveBeenCalled();
    expect(result).toBe(sentinelNoble);
  });
});
