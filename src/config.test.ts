import { describe, it, expect } from 'vitest';
import { loadConfig, type Config } from './config.js';

describe('loadConfig', () => {
  it('returns a frozen Config with valid envs', () => {
    const cfg = loadConfig({
      VOLTRA_ADAPTER: 'mock',
      VMCP_DB_PATH: '/tmp/vmcp-test.sqlite',
      VMCP_LOG_LEVEL: 'debug',
    });

    expect(cfg).toEqual({
      adapter: 'mock',
      dbPath: '/tmp/vmcp-test.sqlite',
      logLevel: 'debug',
    });
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('defaults to the "node" adapter when VOLTRA_ADAPTER is unset', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.adapter).toBe('node');
  });

  it('accepts VOLTRA_ADAPTER="node" explicitly', () => {
    const cfg = loadConfig({ VOLTRA_ADAPTER: 'node', HOME: '/home/test' });
    expect(cfg.adapter).toBe('node');
  });

  it('throws on invalid VOLTRA_ADAPTER, naming the bad value and listing valid options', () => {
    expect(() => loadConfig({ VOLTRA_ADAPTER: 'fake' })).toThrow(/fake/);
    expect(() => loadConfig({ VOLTRA_ADAPTER: 'fake' })).toThrow(/mock/);
    expect(() => loadConfig({ VOLTRA_ADAPTER: 'fake' })).toThrow(/node/);
  });

  it('defaults VMCP_DB_PATH to ~/.voltras/vmcp.sqlite', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.dbPath).toContain('.voltras/vmcp.sqlite');
    expect(cfg.dbPath).toBe('/home/test/.voltras/vmcp.sqlite');
  });

  it('falls back to os.homedir() when HOME is unset', () => {
    const cfg = loadConfig({});
    expect(cfg.dbPath).toContain('.voltras/vmcp.sqlite');
    // os.homedir() is non-empty on every supported platform.
    expect(cfg.dbPath.startsWith('/.voltras')).toBe(false);
  });

  it('defaults VMCP_LOG_LEVEL to "info"', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.logLevel).toBe('info');
  });

  it('honors VMCP_LOG_LEVEL when provided', () => {
    const cfg = loadConfig({ VMCP_LOG_LEVEL: 'warn', HOME: '/home/test' });
    expect(cfg.logLevel).toBe('warn');
  });

  it('produces a value assignable to the Config type', () => {
    const cfg: Config = loadConfig({ VOLTRA_ADAPTER: 'mock', HOME: '/h' });
    expect(cfg.adapter).toBe('mock');
  });
});
