import { describe, it, expect } from 'vitest';
import { loadConfig, type Config } from './config.js';

describe('loadConfig', () => {
  it('returns a frozen Config with valid envs', () => {
    const cfg = loadConfig({
      VOLTRA_ADAPTER: 'mock',
      VMCP_DB_PATH: '/tmp/vmcp-test.sqlite',
      VMCP_SLOT_BINDINGS_PATH: '/tmp/vmcp-test-bindings.json',
      VMCP_LOG_LEVEL: 'debug',
      HOME: '/home/test',
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
      cuesMidSet: 'off',
      autoArm: 'on',
      trueCoachOutbox: 'off',
      trueCoachOutboxDir: '/home/test/.voltras/truecoach-outbox',
      trueCoachSubmitOnEnd: 'off',
      trueCoach: {
        username: undefined,
        password: undefined,
        passwordCommand: undefined,
        clientId: undefined,
        tokenPath: '/home/test/.voltras/truecoach-token.json',
        cacheDir: '/home/test/.voltras/truecoach-cache',
      },
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

  it('defaults VMCP_CUES_MIDSET to "off"', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.cuesMidSet).toBe('off');
  });

  it('honors VMCP_CUES_MIDSET="on" when explicitly set', () => {
    const cfg = loadConfig({ VMCP_CUES_MIDSET: 'on', HOME: '/home/test' });
    expect(cfg.cuesMidSet).toBe('on');
  });

  it('defaults VMCP_AUTO_ARM to "on" (VW-164 — losing the first reps of a set is worse)', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.autoArm).toBe('on');
  });

  it('honors VMCP_AUTO_ARM="off" when explicitly set', () => {
    const cfg = loadConfig({ VMCP_AUTO_ARM: 'off', HOME: '/home/test' });
    expect(cfg.autoArm).toBe('off');
  });

  it('throws on invalid VMCP_AUTO_ARM, naming the bad value and listing valid options', () => {
    expect(() => loadConfig({ VMCP_AUTO_ARM: 'yes' })).toThrow(/yes/);
    expect(() => loadConfig({ VMCP_AUTO_ARM: 'yes' })).toThrow(/off/);
    expect(() => loadConfig({ VMCP_AUTO_ARM: 'yes' })).toThrow(/on/);
  });

  it('defaults VMCP_TRUECOACH_OUTBOX to "off" — the file drop is opt-in', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.trueCoachOutbox).toBe('off');
  });

  it('honors VMCP_TRUECOACH_OUTBOX_DIR when provided', () => {
    const cfg = loadConfig({ VMCP_TRUECOACH_OUTBOX_DIR: '/elsewhere/outbox', HOME: '/home/test' });
    expect(cfg.trueCoachOutboxDir).toBe('/elsewhere/outbox');
  });

  it('throws on invalid VMCP_TRUECOACH_OUTBOX, naming the bad value and listing valid options', () => {
    expect(() => loadConfig({ VMCP_TRUECOACH_OUTBOX: 'yes' })).toThrow(/yes/);
    expect(() => loadConfig({ VMCP_TRUECOACH_OUTBOX: 'yes' })).toThrow(/off/);
    expect(() => loadConfig({ VMCP_TRUECOACH_OUTBOX: 'yes' })).toThrow(/on/);
  });

  it('defaults VMCP_TRUECOACH_SUBMIT_ON_END to "off" — the write-back is opt-in', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.trueCoachSubmitOnEnd).toBe('off');
  });

  it('honors VMCP_TRUECOACH_SUBMIT_ON_END when provided', () => {
    const cfg = loadConfig({ VMCP_TRUECOACH_SUBMIT_ON_END: 'on', HOME: '/home/test' });
    expect(cfg.trueCoachSubmitOnEnd).toBe('on');
  });

  it('throws on invalid VMCP_TRUECOACH_SUBMIT_ON_END, naming the bad value and listing valid options', () => {
    expect(() => loadConfig({ VMCP_TRUECOACH_SUBMIT_ON_END: 'yes' })).toThrow(/yes/);
    expect(() => loadConfig({ VMCP_TRUECOACH_SUBMIT_ON_END: 'yes' })).toThrow(/off/);
    expect(() => loadConfig({ VMCP_TRUECOACH_SUBMIT_ON_END: 'yes' })).toThrow(/on/);
  });

  it('throws on invalid VMCP_CUES_MIDSET, naming the bad value and listing valid options', () => {
    expect(() => loadConfig({ VMCP_CUES_MIDSET: 'yes' })).toThrow(/yes/);
    expect(() => loadConfig({ VMCP_CUES_MIDSET: 'yes' })).toThrow(/off/);
    expect(() => loadConfig({ VMCP_CUES_MIDSET: 'yes' })).toThrow(/on/);
  });

  it('leaves every TrueCoach credential absent by default', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.trueCoach.username).toBeUndefined();
    expect(cfg.trueCoach.password).toBeUndefined();
    expect(cfg.trueCoach.passwordCommand).toBeUndefined();
    expect(cfg.trueCoach.clientId).toBeUndefined();
  });

  it('defaults the TrueCoach token and cache paths under ~/.voltras', () => {
    const cfg = loadConfig({ HOME: '/home/test' });
    expect(cfg.trueCoach.tokenPath).toBe('/home/test/.voltras/truecoach-token.json');
    expect(cfg.trueCoach.cacheDir).toBe('/home/test/.voltras/truecoach-cache');
  });

  it('reads the TrueCoach credentials from their env vars', () => {
    const cfg = loadConfig({
      HOME: '/home/test',
      VMCP_TRUECOACH_USERNAME: 'lifter@example.test',
      VMCP_TRUECOACH_PASSWORD_CMD: 'security find-generic-password -s truecoach -w',
      VMCP_TRUECOACH_CLIENT_ID: '4242',
    });
    expect(cfg.trueCoach.username).toBe('lifter@example.test');
    expect(cfg.trueCoach.passwordCommand).toBe('security find-generic-password -s truecoach -w');
    expect(cfg.trueCoach.clientId).toBe('4242');
  });
});
