// Opt-in BLE "flight recorder" (VMCP-02.xx).
//
// When enabled (`VMCP_RECORD_SESSION=1`), appends every inbound raw BLE frame
// the bridge observes to a per-process JSONL capture, in the EXACT
// `{ type: 'frame_in', ts, hex }` schema the SDK's `loadCaptureFrames` /
// `ReplayBLEAdapter` consume. That lets a bench session be replayed set-by-set
// off-hardware afterward — turning hardware-gated rep-source / firmware
// debugging (VW-16, the 4-vs-5 gate, the tiny-ROM over-count) into a
// deterministic desk exercise.
//
// The bridge already sees every inbound frame at one choke point
// (`event-bridge.ts` `client.onRawFrame`) and tees them into the in-memory
// debug ring buffer; this persists that same stream so it survives past the
// 256-frame ring and a process restart.
//
// Confidentiality (NF-07): a capture holds raw protocol bytes. It is written ONLY to a
// local, gitignored private dir (default `~/.voltras/captures`, never inside a
// repo). Nothing here is surfaced in tool I/O, logs, commits, or the dashboard
// — `status()` returns a file handle + counts, NEVER frame bytes. `record()`
// swallows every error so a capture fault can never break the live BLE path.

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { log } from '../logger.js';

/** Bumped if the capture line schema ever changes (loader compatibility). */
export const CAPTURE_SCHEMA_VERSION = 1;

export interface SessionRecorderOptions {
  /** Master switch — false makes every `record` a no-op and opens no file. */
  enabled: boolean;
  /** Directory the capture file is written to (created on first frame). */
  dir: string;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Filename stamp; injected in tests for determinism. */
  fileStamp?: string;
}

/** Non-byte-bearing recorder status, safe to surface in tool I/O. */
export interface SessionRecorderStatus {
  enabled: boolean;
  active: boolean;
  path: string | null;
  frameCount: number;
  startedAt: string | null;
}

export class SessionRecorder {
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly fileStamp: string;
  private path: string | null = null;
  private startMs = 0;
  private frameCount = 0;
  private opened = false;
  private failed = false;

  constructor(opts: SessionRecorderOptions) {
    this.enabled = opts.enabled;
    this.dir = opts.dir;
    this.now = opts.now ?? ((): number => Date.now());
    this.fileStamp = opts.fileStamp ?? new Date(this.now()).toISOString().replace(/[:.]/g, '-');
  }

  /**
   * Append one inbound BLE frame as a `frame_in` capture line. No-op unless
   * enabled; opens the file lazily on the first frame. NEVER throws — a write
   * fault disables the recorder and logs, but the live BLE path continues.
   */
  record(data: Uint8Array): void {
    if (!this.enabled || this.failed) return;
    try {
      if (!this.opened) this.open();
      const line = JSON.stringify({
        type: 'frame_in',
        ts: this.now() - this.startMs,
        hex: Buffer.from(data).toString('hex'),
      });
      appendFileSync(this.path as string, `${line}\n`);
      this.frameCount += 1;
    } catch (err) {
      this.failed = true;
      log.error('session-recorder write failed; disabling capture', err);
    }
  }

  status(): SessionRecorderStatus {
    return {
      enabled: this.enabled,
      active: this.opened && !this.failed,
      path: this.path,
      frameCount: this.frameCount,
      startedAt: this.opened ? new Date(this.startMs).toISOString() : null,
    };
  }

  private open(): void {
    mkdirSync(this.dir, { recursive: true });
    this.startMs = this.now();
    this.path = join(this.dir, `voltra-capture-${this.fileStamp}.jsonl`);
    // Provenance header. The loader ignores any non-`frame_in` line, so this is
    // replay-safe metadata.
    const meta = JSON.stringify({
      type: 'capture_meta',
      schema: CAPTURE_SCHEMA_VERSION,
      startedAt: new Date(this.startMs).toISOString(),
    });
    appendFileSync(this.path, `${meta}\n`);
    this.opened = true;
    log.info(`session-recorder capturing BLE frames to ${this.path}`);
  }
}

let singleton: SessionRecorder | null = null;

/**
 * Process-wide recorder singleton (mirrors `getDebugBuffers()`). Reads config
 * from the environment once: `VMCP_RECORD_SESSION` (enable) and
 * `VMCP_CAPTURE_DIR` (override the default private capture dir).
 */
export function getSessionRecorder(): SessionRecorder {
  if (singleton === null) {
    const flag = process.env.VMCP_RECORD_SESSION;
    singleton = new SessionRecorder({
      enabled: flag === '1' || flag === 'true',
      dir: process.env.VMCP_CAPTURE_DIR ?? join(homedir(), '.voltras', 'captures'),
    });
  }
  return singleton;
}

/** Test seam: drop the singleton so the next `getSessionRecorder()` re-reads env. */
export function __resetSessionRecorder(): void {
  singleton = null;
}
