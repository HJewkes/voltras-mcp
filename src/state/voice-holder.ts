// The process-wide voice listener holder. It lives on `ServerState`, so it
// sits in `state/` rather than beside the `system.listen_*` tools (VW-857).

import type { ToolResult } from '../tools/helpers.js';
import type { VoiceListener, VoiceListenerDeps } from '../voice/voice-listener.js';

/**
 * Singleton holder so a single VoiceListener lives across listen_start /
 * listen_stop cycles. Sits on `ServerState` so tests can inject a fake
 * VoiceListener (or plug a fully-mocked deps bundle through `__deps`).
 */
export interface VoiceListenerHolder {
  listener: VoiceListener | null;
  /**
   * In-flight `listen_start`. Arming now waits on the mic (~530 ms, up to
   * MIC_READY_TIMEOUT_MS), so a concurrent listen_start/listen_stop has a real
   * window to land in. Both join this instead of racing it — otherwise a second
   * start opens a second sox recorder and leaks the loser, and a stop reports
   * `stopped` while the arm completes behind it and leaves the mic hot.
   */
  starting: Promise<ToolResult> | null;
  __deps: VoiceListenerDeps | null;
}

export function makeVoiceHolder(deps: VoiceListenerDeps | null = null): VoiceListenerHolder {
  return { listener: null, starting: null, __deps: deps };
}
