// Mutable runtime settings for the deterministic cue emitter (VMCP-02.85).
//
// `VMCP_CUES` / `VMCP_CUES_MIDSET` used to be captured at wiring time, so
// changing either meant restarting the whole Claude Code session — the MCP
// server is a child of `claude` and cannot be restarted on its own. That cost
// two restarts during the 2026-08-11 bench sitting, and a missing
// `VMCP_CUES_MIDSET` fails SILENTLY: the mid-set categories just never fire.
//
// So the env vars are now only the STARTUP DEFAULTS. This object is what the
// emitter reads on every event, and `system.set_cues` mutates it in place.
// The macOS gate is deliberately NOT here: `say` genuinely does not exist off
// darwin, so that stays a static check inside `CueEmitter`.

import type { Config } from '../config.js';

export interface CueSettings {
  /** Whether any cue may speak (`VMCP_CUES` at startup). */
  enabled: boolean;
  /**
   * Whether the mid-set categories (`target_hit` / `slowdown`) may speak
   * (`VMCP_CUES_MIDSET` at startup). Independent of {@link enabled}: with
   * cues off, nothing speaks regardless.
   */
  midSetEnabled: boolean;
}

/** Seed the runtime settings from the startup config. */
export function makeCueSettings(config: Pick<Config, 'cues' | 'cuesMidSet'>): CueSettings {
  return { enabled: config.cues === 'on', midSetEnabled: config.cuesMidSet === 'on' };
}
