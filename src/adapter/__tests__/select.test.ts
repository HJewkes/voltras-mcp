import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../config.js';

// Stub the SDK to avoid pulling in optional peer deps (react-native-ble-plx,
// noble) at unit-test time. We only need the two static factory methods used
// by selectAdapter.
const sentinelMock = { __kind: 'mock-manager' };
const sentinelNode = { __kind: 'node-manager' };
const forMockSpy = vi.fn(() => sentinelMock);
const forNodeSpy = vi.fn(() => sentinelNode);

vi.mock('@voltras/node-sdk', () => ({
  VoltraManager: {
    forMock: forMockSpy,
    forNode: forNodeSpy,
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
    forNodeSpy.mockClear();
  });

  it('returns VoltraManager.forMock() when adapter is "mock"', () => {
    const result = selectAdapter(baseConfig('mock'));
    expect(forMockSpy).toHaveBeenCalledTimes(1);
    expect(forNodeSpy).not.toHaveBeenCalled();
    expect(result).toBe(sentinelMock);
  });

  it('returns VoltraManager.forNode() when adapter is "node"', () => {
    const result = selectAdapter(baseConfig('node'));
    expect(forNodeSpy).toHaveBeenCalledTimes(1);
    expect(forMockSpy).not.toHaveBeenCalled();
    expect(result).toBe(sentinelNode);
  });
});
