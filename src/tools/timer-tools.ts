// `timer.wait` and `timer.cancel` — long-running rest-timer surface.
//
// Design intent (see `coordination/HANDOFF-2026-05-04.md` discussion):
//   `timer.wait` BLOCKS for the requested duration before returning. The tool
//   description below explicitly directs Claude Code to run the call as a
//   background task — the same pattern as `Bash` with `run_in_background:
//   true` — so the conversation continues normally while the timer counts
//   down. When the call returns, that completion *is* the wake-up signal: the
//   trainer flow ("rest is up, ready for the next set?") naturally resumes on
//   Claude's next turn.
//
//   The tool deliberately avoids the start-and-poll alternative (instant
//   return + a `voltra://timer/active` resource): polling adds turns to the
//   conversation, costs tokens, and surfaces stale state when Claude is busy
//   talking to the user.
//
// Concurrency:
//   One singleton in-flight timer per server process. A second `timer.wait`
//   while another is running returns `BUSY` rather than queuing — queuing
//   would change observable Claude behavior in ways the description doesn't
//   advertise. The trainer should `timer.cancel` first if it really wants to
//   reset.
//
// Cancellation:
//   `timer.cancel` resolves the in-flight `timer.wait` promise early with
//   `status: 'cancelled'`. If no timer is active, it's a no-op success
//   (idempotent — handlers can fire-and-forget). The cancel path uses the
//   same `Promise<TimerOutcome>` resolver the timeout would use, so there's
//   no race between expiry and cancel.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TimerCancelInput, TimerWaitInput } from '../schemas/timer.js';
import { errorResult, textResult, type ToolResult } from './helpers.js';

interface TimerOutcome {
  readonly status: 'completed' | 'cancelled';
  readonly elapsedMs: number;
  readonly requestedMs: number;
  readonly label?: string | undefined;
}

/**
 * Singleton state for the in-flight timer. Module-scoped on purpose: each
 * server process has exactly one stdio client, so a single timer is the
 * natural granularity. Tests should call `__resetTimerState()` between cases.
 */
interface ActiveTimer {
  readonly resolve: (outcome: TimerOutcome) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly startedAt: number;
  readonly requestedMs: number;
  readonly label?: string | undefined;
}

let active: ActiveTimer | null = null;

/** Test-only: clear any in-flight timer between cases. */
export function __resetTimerState(): void {
  if (active !== null) {
    clearTimeout(active.timeout);
    active.resolve({
      status: 'cancelled',
      elapsedMs: Date.now() - active.startedAt,
      requestedMs: active.requestedMs,
      label: active.label,
    });
    active = null;
  }
}

const WAIT_TOOL_DESCRIPTION = [
  'Wait for a fixed duration before returning. Use this for rest timers',
  'between sets, between-session breaks, or any "wait N seconds before',
  'nudging" moment in the trainer flow.',
  '',
  'IMPORTANT — run this in the background. This call BLOCKS until the timer',
  'expires (or `timer.cancel` is called). Invoke it the same way you would',
  '`Bash` with `run_in_background: true`: kick it off, then continue handling',
  "the user's messages and other tool calls in the meantime. The completion",
  "of this call is itself the wake-up signal — when it returns, that's your",
  'cue to nudge the user (e.g., "rest is up, ready for the next set?").',
  '',
  'Only one timer can be active at a time per server process. Starting a',
  'second `timer.wait` while another is in flight returns a `BUSY` error;',
  'call `timer.cancel` first to reset.',
].join(' ');

const CANCEL_TOOL_DESCRIPTION = [
  'Cancel the active `timer.wait` if one is running. The cancelled',
  '`timer.wait` returns immediately with `status: "cancelled"`. If no timer',
  'is active, this is a no-op success — safe to call defensively before',
  'starting a new timer.',
].join(' ');

/**
 * Swap real handlers for `timer.wait` and `timer.cancel` into their
 * `STARTING` placeholders.
 */
export function registerTimerTools(
  _server: McpServer,
  placeholders: Map<string, RegisteredTool>,
): void {
  placeholders.get('timer.wait')?.update({
    description: WAIT_TOOL_DESCRIPTION,
    paramsSchema: TimerWaitInput.shape,
    callback: makeWaitCallback(),
  });
  placeholders.get('timer.cancel')?.update({
    description: CANCEL_TOOL_DESCRIPTION,
    paramsSchema: TimerCancelInput.shape,
    callback: makeCancelCallback(),
  });
}

function makeWaitCallback(): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = TimerWaitInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    if (active !== null) {
      return errorResult({
        code: 'BUSY',
        message: 'Another timer is already running. Call timer.cancel first.',
      });
    }
    const { durationMs, label } = parsed.data;
    const startedAt = Date.now();
    const outcome = await new Promise<TimerOutcome>((resolve) => {
      const timeout = setTimeout(() => {
        active = null;
        resolve({
          status: 'completed',
          elapsedMs: Date.now() - startedAt,
          requestedMs: durationMs,
          label,
        });
      }, durationMs);
      active = { resolve, timeout, startedAt, requestedMs: durationMs, label };
    });
    return textResult(outcome);
  };
}

function makeCancelCallback(): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = TimerCancelInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    if (active === null) {
      return textResult({ cancelled: false, reason: 'no active timer' });
    }
    const a = active;
    clearTimeout(a.timeout);
    active = null;
    a.resolve({
      status: 'cancelled',
      elapsedMs: Date.now() - a.startedAt,
      requestedMs: a.requestedMs,
      label: a.label,
    });
    return textResult({ cancelled: true, label: a.label });
  };
}
