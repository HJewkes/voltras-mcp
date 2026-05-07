// Process-local ring buffers for diagnostic frame + event capture.
//
// The bridge appends to these on every onFrame / on*Boundary / onSettingsUpdate
// / onConnectionStateChange callback so the `debug.recent_frames` and
// `debug.recent_events` tools can return what the bridge actually saw,
// independent of LiveState mutations.
//
// Capacity is fixed at construction time (default 256, override via
// `VMCP_DEBUG_BUFFER_SIZE`); the underlying storage is a `[capacity]`-sized
// array reused across pushes via a write head index. Every push is O(1) and
// allocates only the inserted record.
//
// Buffers are intentionally process-local. Restart drops them; that's fine
// for a diagnostic surface.

const DEFAULT_CAPACITY = 256;

/** A single telemetry frame snapshot retained by the debug buffer. */
export interface DebugFrame {
  sequence: number;
  timestamp: number;
  phase: number;
  position: number;
  velocity: number;
  force: number;
}

/**
 * A single bridge-level event. `payload` is a small structured object — never
 * a raw protocol buffer. The exact shape varies by `type`.
 */
export interface DebugEvent {
  /** Wall-clock timestamp (ms since epoch) when the bridge observed the event. */
  capturedAt: number;
  type:
    | 'rep_boundary'
    | 'set_boundary'
    | 'summary'
    | 'settings_update'
    | 'connection_state_change'
    | 'cycle_complete'
    | 'guided_load_state';
  payload: Record<string, unknown>;
}

/**
 * Fixed-capacity ring buffer. `push` overwrites the oldest entry once full;
 * `recent(n)` returns the last `n` entries in chronological (oldest-first)
 * order, capped at the buffer's current size.
 */
export class RingBuffer<T> {
  private readonly slots: (T | undefined)[];
  private writeHead = 0;
  private size = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.slots = new Array<T | undefined>(capacity).fill(undefined);
  }

  push(value: T): void {
    this.slots[this.writeHead] = value;
    this.writeHead = (this.writeHead + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /** Number of entries currently stored (0..capacity). */
  length(): number {
    return this.size;
  }

  /**
   * Return the most recent `n` entries (oldest-first). `n` is clamped to
   * `[0, length()]`. Returns a fresh array; callers may mutate freely.
   */
  recent(n: number): T[] {
    const take = Math.max(0, Math.min(n, this.size));
    if (take === 0) return [];
    const out: T[] = new Array(take);
    const start = (this.writeHead - this.size + this.capacity) % this.capacity;
    const skip = this.size - take;
    for (let i = 0; i < take; i += 1) {
      const idx = (start + skip + i) % this.capacity;
      out[i] = this.slots[idx] as T;
    }
    return out;
  }

  /** Drop every stored entry. */
  clear(): void {
    for (let i = 0; i < this.capacity; i += 1) this.slots[i] = undefined;
    this.writeHead = 0;
    this.size = 0;
  }
}

/** Pair of process-wide buffers consumed by the debug.* tools. */
export interface DebugBuffers {
  frames: RingBuffer<DebugFrame>;
  events: RingBuffer<DebugEvent>;
  capacity: number;
}

function readCapacity(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VMCP_DEBUG_BUFFER_SIZE;
  if (raw === undefined || raw === '') return DEFAULT_CAPACITY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CAPACITY;
  return parsed;
}

let shared: DebugBuffers | undefined;

/**
 * Lazily build (or fetch) the singleton debug buffers. The bridge and the
 * `debug.*` tool handlers both call this so they share storage without
 * threading a parameter through every event.
 */
export function getDebugBuffers(): DebugBuffers {
  if (shared === undefined) {
    const capacity = readCapacity();
    shared = {
      frames: new RingBuffer<DebugFrame>(capacity),
      events: new RingBuffer<DebugEvent>(capacity),
      capacity,
    };
  }
  return shared;
}

/** Test-only: drop the shared instance so a re-read of env picks up overrides. */
export function _resetDebugBuffersForTest(): void {
  shared = undefined;
}
