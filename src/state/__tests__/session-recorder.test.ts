import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFrame,
  encodeTelemetryFrame,
  decodeTelemetryFrame,
  identifyMessageType,
  MovementPhase,
} from '@voltras/node-sdk';
import { SessionRecorder } from '../session-recorder.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vmcp-capture-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('SessionRecorder', () => {
  it('is a no-op when disabled — opens no file', () => {
    const rec = new SessionRecorder({ enabled: false, dir, fileStamp: 'x' });
    rec.record(new Uint8Array([1, 2, 3]));
    expect(rec.status()).toMatchObject({ enabled: false, active: false, frameCount: 0 });
    expect(existsSync(join(dir, 'voltra-capture-x.jsonl'))).toBe(false);
  });

  it('writes a capture_meta header then one frame_in line per frame', () => {
    let t = 1000;
    const rec = new SessionRecorder({ enabled: true, dir, fileStamp: 'run1', now: () => t });
    rec.record(new Uint8Array([0xaa, 0xbb]));
    t = 1040;
    rec.record(new Uint8Array([0xcc]));

    const path = join(dir, 'voltra-capture-run1.jsonl');
    const lines = readLines(path);
    expect(lines[0]).toMatchObject({ type: 'capture_meta', schema: 1 });
    expect(lines[1]).toMatchObject({ type: 'frame_in', ts: 0, hex: 'aabb' });
    // ts is session-relative: second frame 40ms after open.
    expect(lines[2]).toMatchObject({ type: 'frame_in', ts: 40, hex: 'cc' });
    expect(rec.status()).toMatchObject({ enabled: true, active: true, frameCount: 2, path });
  });

  it('produces frame_in lines that round-trip through the SDK replay codec', () => {
    // Build a real telemetry frame, encode it exactly as a device would emit it,
    // record it, then decode the recorded hex back — the same path
    // `loadCaptureFrames` / `ReplayBLEAdapter` take. Proves the capture is replayable.
    const frame = createFrame(7, MovementPhase.CONCENTRIC, 1234, 88, 56);
    const bytes = encodeTelemetryFrame(frame);

    const rec = new SessionRecorder({ enabled: true, dir, fileStamp: 'rt', now: () => 5000 });
    rec.record(bytes);

    const lines = readLines(join(dir, 'voltra-capture-rt.jsonl'));
    const frameLine = lines.find((l) => l.type === 'frame_in');
    expect(frameLine).toBeDefined();

    const recovered = Buffer.from(frameLine!.hex as string, 'hex');
    expect(identifyMessageType(recovered)).toBe('telemetry_stream');
    const decoded = decodeTelemetryFrame(recovered);
    expect(decoded).not.toBeNull();
    expect(decoded!.sequence).toBe(7);
    expect(decoded!.position).toBe(1234);
  });

  it('status() reflects an unopened recorder before the first frame', () => {
    const rec = new SessionRecorder({ enabled: true, dir, fileStamp: 'y' });
    expect(rec.status()).toMatchObject({ enabled: true, active: false, path: null, frameCount: 0 });
  });
});
