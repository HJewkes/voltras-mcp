// Unit tests for the speech segmenter (VMCP-02.77 P2).
//
// Pure state machine — direct import, no mocks. We drive synthetic (prob, pcm)
// sequences. Each frame is a 1024-byte Buffer (512 samples @16k = 32 ms), so
// segment timing derives to 32 ms/frame and byte length == frameCount * 1024.

import { describe, expect, it } from 'vitest';
import { SpeechSegmenter } from '../speech-segmenter.js';

const FRAME_BYTES = 512 * 2; // 512 samples * 2 bytes = 1024 bytes == 32 ms @16k

// A recognizable frame: every byte is `fill`, so ordering/pattern is assertable.
function frame(fill: number): Buffer {
  return Buffer.alloc(FRAME_BYTES, fill);
}

function frameCount(buf: Buffer): number {
  return buf.length / FRAME_BYTES;
}

describe('SpeechSegmenter', () => {
  it('never emits on a silence-only stream', () => {
    const seg = new SpeechSegmenter();
    let emitted: Buffer | null = null;
    for (let i = 0; i < 100; i++) emitted = seg.push(0.0, frame(0x00)) ?? emitted;
    expect(emitted).toBeNull();
    expect(seg.flush()).toBeNull();
  });

  it('emits once, on the frame that completes the hangover', () => {
    // No pre-roll (start directly with speech): emitted == voiced frames only.
    const seg = new SpeechSegmenter(); // hangover 400ms => 13 silence frames @32ms
    const emits: Buffer[] = [];

    for (let i = 0; i < 10; i++) {
      const out = seg.push(0.9, frame(0xbb));
      if (out) emits.push(out);
    }
    // 12 silence frames (384ms) stay open; the 13th (416ms) closes.
    for (let i = 0; i < 12; i++) expect(seg.push(0.0, frame(0x00))).toBeNull();
    const closed = seg.push(0.0, frame(0x00));

    expect(emits).toHaveLength(0);
    expect(closed).not.toBeNull();
    expect(frameCount(closed!)).toBe(10); // trailing hangover silence trimmed
    expect(closed![0]).toBe(0xbb);
  });

  it('discards a too-short blip below minSpeechMs', () => {
    const seg = new SpeechSegmenter(); // minSpeechMs 200 => needs > ~6 voiced frames
    let emitted: Buffer | null = null;

    // 2 voiced frames (64 ms) then enough silence to close on hangover.
    for (let i = 0; i < 2; i++) emitted = seg.push(0.9, frame(0xbb)) ?? emitted;
    for (let i = 0; i < 13; i++) emitted = seg.push(0.0, frame(0x00)) ?? emitted;

    expect(emitted).toBeNull(); // 64 ms < 200 ms => discarded
    expect(seg.flush()).toBeNull(); // and it reset to idle (nothing left to flush)
  });

  it('force-closes at maxSegmentMs even without trailing silence', () => {
    // Cap above minSpeechMs (default 200) so the force-closed segment is kept.
    const seg = new SpeechSegmenter({ maxSegmentMs: 300 }); // cap => 10 frames (320ms)
    const emits: Buffer[] = [];

    for (let i = 0; i < 15; i++) {
      const out = seg.push(0.95, frame(0xcc));
      if (out) emits.push(out);
    }

    expect(emits).toHaveLength(1); // closed exactly once at the cap
    expect(frameCount(emits[0])).toBe(10); // 10 * 32ms = 320ms >= 300ms cap
  });

  it('includes pre-roll frames captured before onset, in order', () => {
    // Large preRoll retains all 3 idle frames; assert their patterns lead the buffer.
    const seg = new SpeechSegmenter({ preRollMs: 1000 });
    let emitted: Buffer | null = null;

    seg.push(0.0, frame(0xa1));
    seg.push(0.0, frame(0xa2));
    seg.push(0.0, frame(0xa3));
    for (let i = 0; i < 10; i++) emitted = seg.push(0.9, frame(0xbb)) ?? emitted;
    for (let i = 0; i < 13; i++) emitted = seg.push(0.0, frame(0x00)) ?? emitted;

    expect(emitted).not.toBeNull();
    expect(emitted![0]).toBe(0xa1); // first pre-roll frame leads the buffer
    expect(emitted![1 * FRAME_BYTES]).toBe(0xa2);
    expect(emitted![2 * FRAME_BYTES]).toBe(0xa3);
    expect(emitted![3 * FRAME_BYTES]).toBe(0xbb); // speech follows pre-roll
    expect(frameCount(emitted!)).toBe(3 + 10); // 3 pre-roll + 10 voiced, hangover trimmed
  });

  it('flush() mid-speech returns the partial segment', () => {
    const seg = new SpeechSegmenter();
    for (let i = 0; i < 10; i++) expect(seg.push(0.9, frame(0xbb))).toBeNull();

    const flushed = seg.flush();
    expect(flushed).not.toBeNull();
    expect(frameCount(flushed!)).toBe(10);
  });

  it('flush() while idle returns null', () => {
    const seg = new SpeechSegmenter();
    expect(seg.flush()).toBeNull();
    seg.push(0.0, frame(0x00));
    expect(seg.flush()).toBeNull();
  });

  it('applies hysteresis: enter and exit thresholds are distinct', () => {
    // Default enter 0.5, exit 0.35. A dip to 0.4 must NOT start speech while idle,
    // and must NOT count as silence once speech is underway.
    const seg = new SpeechSegmenter({ preRollMs: 0 }); // isolate: no pre-roll frames

    // 0.4 while idle: below enter (0.5) => no speech begins.
    expect(seg.push(0.4, frame(0x40))).toBeNull();

    // Start speech, then hold at 0.4 (>= exit) for longer than the hangover.
    expect(seg.push(0.9, frame(0xbb))).toBeNull();
    for (let i = 0; i < 20; i++) {
      expect(seg.push(0.4, frame(0xbb))).toBeNull(); // 0.4 >= exit => keeps speech alive
    }

    // Now drop below exit for a full hangover => closes.
    let closed: Buffer | null = null;
    for (let i = 0; i < 13; i++) closed = seg.push(0.0, frame(0x00)) ?? closed;
    expect(closed).not.toBeNull();
    expect(frameCount(closed!)).toBe(1 + 20); // onset + 20 sustained voiced frames
  });
});
