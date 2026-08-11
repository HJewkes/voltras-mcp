// `system.set_cues` — flip the deterministic cue emitter's two switches at
// runtime (VMCP-02.85).
//
// `VMCP_CUES` / `VMCP_CUES_MIDSET` are startup defaults only. The server runs
// as a child of `claude`, so before this tool existed the ONLY way to change
// either was to restart the whole Claude Code session — and a wrong
// `VMCP_CUES_MIDSET` fails silently (the mid-set categories simply never
// speak), so a misconfigured bench sitting can be discovered only after the
// fact. This tool mutates `state.cueSettings` in place, which the emitter reads
// per event, and always echoes the resulting state so a caller can verify.
//
// The macOS gate is NOT toggleable: `say` does not exist off darwin, so cues
// stay silent there whatever this reports.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

import { SystemSetCuesInput, type SystemSetCuesInputType } from '../schemas/system.js';
import type { CueSettings } from '../voice/cue-settings.js';
import { wrapHandler } from './helpers.js';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

/** Slot-shaped state injection — only the field the cue tool needs. */
export interface CueToolState {
  cueSettings: CueSettings;
}

const DESCRIPTION = [
  'Turn the deterministic spoken coaching cues on or off WITHOUT restarting the',
  'server. `cues` is the master switch (set intros, target-hit, slowdown,',
  'set-complete); `midSet` separately allows the two categories that fire while',
  'the lifter is still under load (`target_hit`, `slowdown`) — those stay silent',
  'unless BOTH are on, because every cue mutes the mic for its duration and that',
  'blind spot is worst mid-set. Omitted fields are left unchanged; a call with no',
  'fields just reports current state. `VMCP_CUES` / `VMCP_CUES_MIDSET` are only the',
  'startup defaults (both `off`). macOS-only: cues never speak on other platforms',
  'regardless of these settings. `server.health` reports the same values.',
].join(' ');

/** Report the settings in the same on/off vocabulary the env vars use. */
function describe(settings: CueSettings): { cues: 'on' | 'off'; midSet: 'on' | 'off' } {
  return {
    cues: settings.enabled ? 'on' : 'off',
    midSet: settings.midSetEnabled ? 'on' : 'off',
  };
}

function applyCueSettings(settings: CueSettings, input: SystemSetCuesInputType): unknown {
  const before = describe(settings);
  if (input.cues !== undefined) settings.enabled = input.cues === 'on';
  if (input.midSet !== undefined) settings.midSetEnabled = input.midSet === 'on';
  const after = describe(settings);
  return {
    ...after,
    changed: before.cues !== after.cues || before.midSet !== after.midSet,
    platformSupported: process.platform === 'darwin',
  };
}

/** Hot-swap the `system.set_cues` placeholder with the real handler. */
export function registerCueTools(
  _server: McpServer,
  state: CueToolState,
  placeholders: PlaceholderTools,
): void {
  const tool = placeholders.get('system.set_cues');
  if (tool === undefined) {
    throw new Error('tool placeholder not registered: system.set_cues');
  }
  tool.update({
    description: DESCRIPTION,
    paramsSchema: SystemSetCuesInput.shape,
    callback: wrapHandler(SystemSetCuesInput, (input) =>
      Promise.resolve(applyCueSettings(state.cueSettings, input)),
    ) as never,
  });
}
