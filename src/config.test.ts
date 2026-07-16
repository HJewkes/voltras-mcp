import { describe, it, expect } from 'vitest';
import { loadConfig, type Config } from './config.js';

describe('loadConfig', () => {
  it('returns a frozen Config with valid envs', () => {
    const cfg = loadConfig({
      VOLTRA_ADAPTER: 'mock',
      VMCP_DB_PATH: '/tmp/vmcp-test.sqlite',
      VMCP_SLOT_BINDINGS_PATH: '/tmp/vmcp-test-bindings.json',
      VMCP_LOG_LEVEL: 'debug',
    });

    expect(cfg).toEqual({
      adapter: 'mock',
      dbPath: '/tmp/vmcp-test.sqlite',
      slotBindingsPath: '/tmp/vmcp-test-bindings.json',
      logLevel: 'debug',
      repSource: 'analytics',
      restTimer: 'off',
      repCorrections: 'off',
      cues: 'off',
    });
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('defaults VMCP_SLOT_BINDINGS_PATH to ~/.voltras/slot-bindings.json', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.slotBindingsPath).toBe('/home/test/.voltras/slot-bindings.json');
  });

  it('honors VMCP_SLOT_BINDINGS_PATH when provided', () => {
    const cfg = loadConfig({ VMCP_SLOT_BINDINGS_PATH: '/elsewhere/b.json', HOME: '/home/t' });
    expect(cfg.slotBindingsPath).toBe('/elsewhere/b.json');
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

  // VMCP-02.29 PR5 — REP_SOURCE dark switch defaults to analytics.
  it('defaults VMCP_REP_SOURCE to "analytics"', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.repSource).toBe('analytics');
  });

  it('honors VMCP_REP_SOURCE="firmware" when explicitly set', () => {
    const cfg = loadConfig({ VMCP_REP_SOURCE: 'firmware', HOME: '/home/test' });
    expect(cfg.repSource).toBe('firmware');
  });

  it('honors VMCP_REP_SOURCE="analytics" when explicitly set', () => {
    const cfg = loadConfig({ VMCP_REP_SOURCE: 'analytics', HOME: '/home/test' });
    expect(cfg.repSource).toBe('analytics');
  });

  it('throws on invalid VMCP_REP_SOURCE, naming the bad value and listing valid options', () => {
    expect(() => loadConfig({ VMCP_REP_SOURCE: 'fake' })).toThrow(/fake/);
    expect(() => loadConfig({ VMCP_REP_SOURCE: 'fake' })).toThrow(/analytics/);
    expect(() => loadConfig({ VMCP_REP_SOURCE: 'fake' })).toThrow(/firmware/);
  });

  // VMCP-02.54 — the passive rest timer is opt-in, default off.
  it('defaults VMCP_REST_TIMER to "off"', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.restTimer).toBe('off');
  });

  it('honors VMCP_REST_TIMER="on" when explicitly set', () => {
    const cfg = loadConfig({ VMCP_REST_TIMER: 'on', HOME: '/home/test' });
    expect(cfg.restTimer).toBe('on');
  });

  it('throws on invalid VMCP_REST_TIMER, naming the bad value and listing valid options', () => {
    expect(() => loadConfig({ VMCP_REST_TIMER: 'yes' })).toThrow(/yes/);
    expect(() => loadConfig({ VMCP_REST_TIMER: 'yes' })).toThrow(/off/);
    expect(() => loadConfig({ VMCP_REST_TIMER: 'yes' })).toThrow(/on/);
  });

  it('defaults VMCP_REP_CORRECTIONS to "off"', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.repCorrections).toBe('off');
  });

  it('honors VMCP_REP_CORRECTIONS="on" when explicitly set', () => {
    const cfg = loadConfig({ VMCP_REP_CORRECTIONS: 'on', HOME: '/home/test' });
    expect(cfg.repCorrections).toBe('on');
  });

  it('throws on invalid VMCP_REP_CORRECTIONS, naming the bad value and listing valid options', () => {
    expect(() => loadConfig({ VMCP_REP_CORRECTIONS: 'yes' })).toThrow(/yes/);
    expect(() => loadConfig({ VMCP_REP_CORRECTIONS: 'yes' })).toThrow(/off/);
    expect(() => loadConfig({ VMCP_REP_CORRECTIONS: 'yes' })).toThrow(/on/);
  });

  it('defaults VMCP_CUES to "off"', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.cues).toBe('off');
  });

  it('honors VMCP_CUES="on" when explicitly set', () => {
    const cfg = loadConfig({ VMCP_CUES: 'on', HOME: '/home/test' });
    expect(cfg.cues).toBe('on');
  });

  it('throws on invalid VMCP_CUES, naming the bad value and listing valid options', () => {
    expect(() => loadConfig({ VMCP_CUES: 'yes' })).toThrow(/yes/);
    expect(() => loadConfig({ VMCP_CUES: 'yes' })).toThrow(/off/);
    expect(() => loadConfig({ VMCP_CUES: 'yes' })).toThrow(/on/);
  });
});
