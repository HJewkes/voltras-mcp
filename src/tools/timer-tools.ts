// `timer.wait`, `timer.start`, and `timer.cancel` — rest-timer surface.
//
// Two flavors of timer ship side-by-side; pick based on whether the model
// wants to keep talking while the timer runs:
//
//   * `timer.wait({ durationMs, label? })` — BLOCKS for the requested duration
//     before returning. Designed to be invoked the same way `Bash` is run with
//     `run_in_background: true`: kick it off, then continue handling the
//     user's messages, and the eventual return is the wake-up signal. Useful
//     for short, predictable rests where the model has nothing else to do.
//
//   * `timer.start({ durationMs, label })` — returns a `timer_id` immediately
//     and fires a `timer_complete` claude/channel event when the duration
//     elapses. The conversation is NOT held open; the channel event is the
//     wake-up signal, delivered inline as a `<channel>` tag. This is the
//     push-style variant and the preferred shape for any rest >30s where the
//     model wants to stay reactive to the user.
//
//   * `timer.cancel({ timer_id? })` — cancels a timer. With `timer_id`, it
//     targets either a `timer.start` push timer or the in-flight `timer.wait`
//     blocking timer (the wait timer's id is also tracked even though
//     `timer.wait` doesn't return it, for argless legacy behavior). Without
//     `timer_id`, it cancels the singleton blocking `timer.wait` for
//     backward compatibility.
//
// Concurrency:
//   `timer.wait` keeps its singleton-per-process semantics: a second
//   `timer.wait` while one is running returns `BUSY`. `timer.start` timers
//   are independent — multiple can be in flight at once, each tracked by
//   `timer_id` in `state.timers`.
//
// Cancellation:
//   `timer.cancel` resolves the in-flight `timer.wait` promise early with
//   `status: 'cancelled'`. For `timer.start` timers, cancel clears the
//   `setTimeout` so the `timer_complete` event never fires. The cancel path
//   uses the same `Promise<TimerOutcome>` resolver the timeout would use, so
//   there's no race between expiry and cancel.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { TimerCancelInput, TimerStartInput, TimerWaitInput } from '../schemas/timer.js';
import type { ServerState } from '../state/server-state.js';
import { errorResult, textResult, type ToolResult } from './helpers.js';

interface TimerOutcome {
  readonly status: 'completed' | 'cancelled';
  readonly elapsedMs: number;
  readonly requestedMs: number;
  readonly label?: string | undefined;
}

/**
 * Singleton state for the in-flight blocking timer. Module-scoped on
 * purpose: each server process has exactly one stdio client, so a single
 * blocking timer is the natural granularity. Tests should call
 * `__resetTimerState()` between cases.
 */
interface ActiveBlockingTimer {
  readonly id: string;
  readonly resolve: (outcome: TimerOutcome) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly startedAt: number;
  readonly requestedMs: number;
  readonly label?: string | undefined;
}

let blocking: ActiveBlockingTimer | null = null;

/**
 * Push-style timer registry. Lives on `ServerState` so `timer.cancel` can
 * find a timer by id and so process-shutdown teardown can clear the map.
 * Keys are the `timer_id` UUID strings returned from `timer.start`.
 */
export interface PushTimer {
  readonly handle: ReturnType<typeof setTimeout>;
  readonly label: string;
  readonly durationMs: number;
  readonly expectedAt: string;
}

/** Test-only: clear any in-flight blocking timer between cases. */
export function __resetTimerState(): void {
  if (blocking !== null) {
    clearTimeout(blocking.timeout);
    blocking.resolve({
      status: 'cancelled',
      elapsedMs: Date.now() - blocking.startedAt,
      requestedMs: blocking.requestedMs,
      label: blocking.label,
    });
    blocking = null;
  }
}

const WAIT_TOOL_DESCRIPTION = [
  'Wait for a fixed duration before returning. Use this for short rest',
  'timers between sets, between-session breaks, or any "wait N seconds before',
  'nudging" moment in the trainer flow when the model has nothing else to',
  'say in the meantime.',
  '',
  'IMPORTANT — run this in the background. This call BLOCKS until the timer',
  'expires (or `timer.cancel` is called). Invoke it the same way you would',
  '`Bash` with `run_in_background: true`: kick it off, then continue handling',
  "the user's messages and other tool calls in the meantime. The completion",
  "of this call is itself the wake-up signal — when it returns, that's your",
  'cue to nudge the user (e.g., "rest is up, ready for the next set?").',
  '',
  'Only one blocking timer can be active at a time per server process.',
  'Starting a second `timer.wait` while another is in flight returns a',
  '`BUSY` error; call `timer.cancel` first to reset.',
  '',
  'Prefer `timer.start` (push variant) when you want to keep the',
  'conversation open during the rest — `timer.wait` ties up a tool call slot',
  'while it runs, while `timer.start` returns immediately and pushes a',
  '`timer_complete` claude/channel event when the timer elapses.',
].join(' ');

const START_TOOL_DESCRIPTION = [
  'Start a non-blocking timer. Returns a `timer_id` immediately; when the',
  'duration elapses, a `timer_complete` claude/channel event fires with the',
  'label, original duration, and expected fire time. Use this for any rest',
  'longer than ~30s where the model wants to keep talking with the user',
  '(or react to their messages) while the timer counts down.',
  '',
  'Multiple `timer.start` timers can be in flight at once; cancel a specific',
  'one with `timer.cancel({ timer_id })`.',
].join(' ');

const CANCEL_TOOL_DESCRIPTION = [
  'Cancel a timer. With `{ timer_id }`, targets that specific timer (works',
  'for both `timer.start` push timers and the in-flight `timer.wait`',
  'blocking timer). Without arguments, cancels the singleton blocking',
  '`timer.wait` if one is running. If no matching timer is active, this is a',
  'no-op success — safe to call defensively before starting a new timer.',
].join(' ');

/**
 * Swap real handlers for `timer.wait`, `timer.start`, and `timer.cancel`
 * into their `STARTING` placeholders.
 */
export function registerTimerTools(
  _server: McpServer,
  state: ServerState,
  placeholders: Map<string, RegisteredTool>,
): void {
  placeholders.get('timer.wait')?.update({
    description: WAIT_TOOL_DESCRIPTION,
    paramsSchema: TimerWaitInput.shape,
    callback: makeWaitCallback(),
  });
  placeholders.get('timer.start')?.update({
    description: START_TOOL_DESCRIPTION,
    paramsSchema: TimerStartInput.shape,
    callback: makeStartCallback(state),
  });
  placeholders.get('timer.cancel')?.update({
    description: CANCEL_TOOL_DESCRIPTION,
    paramsSchema: TimerCancelInput.shape,
    callback: makeCancelCallback(state),
  });
}

function makeWaitCallback(): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = TimerWaitInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    if (blocking !== null) {
      return errorResult({
        code: 'BUSY',
        message: 'Another timer is already running. Call timer.cancel first.',
      });
    }
    const { durationMs, label } = parsed.data;
    const startedAt = Date.now();
    const id = randomUUID();
    const outcome = await new Promise<TimerOutcome>((resolve) => {
      const timeout = setTimeout(() => {
        blocking = null;
        resolve({
          status: 'completed',
          elapsedMs: Date.now() - startedAt,
          requestedMs: durationMs,
          label,
        });
      }, durationMs);
      blocking = { id, resolve, timeout, startedAt, requestedMs: durationMs, label };
    });
    return textResult(outcome);
  };
}

function makeStartCallback(
  state: ServerState,
): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = TimerStartInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    const { durationMs, label } = parsed.data;
    const id = randomUUID();
    const expectedAt = new Date(Date.now() + durationMs).toISOString();
    const handle = setTimeout(() => {
      // Clean up the registry slot before publishing so any concurrent
      // cancel that loses the race sees the slot as already-fired.
      state.timers.delete(id);
      state.channels.publish({
        content: JSON.stringify({
          summary: `Timer "${label}" (${formatDuration(durationMs)}) complete.`,
        }),
        meta: {
          source: 'voltras',
          event_type: 'timer_complete',
          timer_id: id,
          label,
          duration_ms: String(durationMs),
          expected_at: expectedAt,
        },
      });
    }, durationMs);
    state.timers.set(id, { handle, label, durationMs, expectedAt });
    return textResult({ timer_id: id, label, durationMs, expectedAt });
  };
}

function makeCancelCallback(
  state: ServerState,
): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = TimerCancelInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    const targetId = parsed.data.timer_id;
    if (targetId !== undefined) {
      // Cancel by id: try the push-timer registry first, then the blocking
      // singleton (in case the caller happens to know its id).
      const push = state.timers.get(targetId);
      if (push !== undefined) {
        clearTimeout(push.handle);
        state.timers.delete(targetId);
        return textResult({ cancelled: true, timer_id: targetId, label: push.label });
      }
      if (blocking !== null && blocking.id === targetId) {
        return Promise.resolve(cancelBlocking());
      }
      return textResult({ cancelled: false, reason: 'no matching timer' });
    }
    if (blocking === null) {
      return textResult({ cancelled: false, reason: 'no active timer' });
    }
    return Promise.resolve(cancelBlocking());
  };
}

function cancelBlocking(): ToolResult {
  if (blocking === null) {
    return textResult({ cancelled: false, reason: 'no active timer' });
  }
  const a = blocking;
  clearTimeout(a.timeout);
  blocking = null;
  a.resolve({
    status: 'cancelled',
    elapsedMs: Date.now() - a.startedAt,
    requestedMs: a.requestedMs,
    label: a.label,
  });
  return textResult({ cancelled: true, label: a.label });
}

/**
 * Format a duration in milliseconds as `M:SS` (under 1 hour) or `H:MM:SS`
 * (1 hour or more). Used in the `timer_complete` channel summary so the
 * model and any human reader can see the elapsed time at a glance.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
