// Speech segmenter (VMCP-02.77 P2).
//
// Pure state machine: turns a stream of per-frame VAD probabilities (plus the
// raw PCM for each frame) into discrete speech segments — one concatenated PCM
// Buffer per utterance, emitted when trailing silence closes the utterance.
//
// Audio is 16 kHz mono 16-bit. Frames are a fixed size, but the duration of a
// frame is DERIVED from its byte length (not hardcoded) so a different fixed
// frame size still yields correct timing; `frameMs` in opts can override.

// 16 kHz * 2 bytes/sample / 1000 ms/s => 32 bytes per millisecond of audio.
const BYTES_PER_MS = (16000 * 2) / 1000;

export interface SegmenterOpts {
  enterThreshold?: number; // prob to START speech (default 0.5)
  exitThreshold?: number; // prob below which a frame counts as silence (default 0.35 — hysteresis vs enter)
  hangoverMs?: number; // trailing silence needed to CLOSE a segment (default 400)
  minSpeechMs?: number; // segments shorter than this are discarded as blips (default 200)
  maxSegmentMs?: number; // hard cap; force-close at this length (default 12000)
  preRollMs?: number; // audio kept from BEFORE onset, prepended to the segment (default 200)
  frameMs?: number; // duration of one push()'d frame (default: derived from framePcm.length)
}

interface PreRollFrame {
  buf: Buffer;
  ms: number;
}

export class SpeechSegmenter {
  private readonly enterThreshold: number;
  private readonly exitThreshold: number;
  private readonly hangoverMs: number;
  private readonly minSpeechMs: number;
  private readonly maxSegmentMs: number;
  private readonly preRollMs: number;
  private readonly frameMsOverride: number | undefined;

  private preRoll: PreRollFrame[] = [];
  private preRollMsTotal = 0;

  private inSpeech = false;
  private segment: Buffer[] = [];
  private sinceOnsetMs = 0; // ms accumulated after onset (excludes pre-roll)
  private trailingSilenceMs = 0; // consecutive trailing silence at the segment end
  private trailingSilenceFrames = 0; // count of those trailing silence frames (for trimming)

  constructor(opts: SegmenterOpts = {}) {
    this.enterThreshold = opts.enterThreshold ?? 0.5;
    this.exitThreshold = opts.exitThreshold ?? 0.35;
    this.hangoverMs = opts.hangoverMs ?? 400;
    this.minSpeechMs = opts.minSpeechMs ?? 200;
    this.maxSegmentMs = opts.maxSegmentMs ?? 12000;
    this.preRollMs = opts.preRollMs ?? 200;
    this.frameMsOverride = opts.frameMs;
  }

  // Feed one frame's VAD prob + its raw PCM. Returns the completed utterance
  // (preRoll + speech, trailing hangover trimmed) when the segment closes on
  // this frame, else null.
  push(prob: number, framePcm: Buffer): Buffer | null {
    const frameMs = this.frameMsOverride ?? framePcm.length / BYTES_PER_MS;
    if (!this.inSpeech) {
      if (prob < this.enterThreshold) {
        this.pushPreRoll(framePcm, frameMs);
        return null;
      }
      this.beginSpeech();
      return this.appendSpeechFrame(true, framePcm, frameMs);
    }
    return this.appendSpeechFrame(prob >= this.exitThreshold, framePcm, frameMs);
  }

  // Force-close any open segment (e.g. listener stop()); safe when idle.
  flush(): Buffer | null {
    return this.inSpeech ? this.closeSegment() : null;
  }

  // Keep the most recent frames covering ~preRollMs; drop the oldest once
  // removing it still leaves >= preRollMs of coverage.
  private pushPreRoll(buf: Buffer, ms: number): void {
    this.preRoll.push({ buf, ms });
    this.preRollMsTotal += ms;
    while (this.preRoll.length > 0 && this.preRollMsTotal - this.preRoll[0].ms >= this.preRollMs) {
      this.preRollMsTotal -= this.preRoll.shift()!.ms;
    }
  }

  private beginSpeech(): void {
    this.inSpeech = true;
    this.segment = this.preRoll.map((f) => f.buf);
    this.preRoll = [];
    this.preRollMsTotal = 0;
    this.sinceOnsetMs = 0;
    this.trailingSilenceMs = 0;
    this.trailingSilenceFrames = 0;
  }

  private appendSpeechFrame(voiced: boolean, framePcm: Buffer, frameMs: number): Buffer | null {
    this.segment.push(framePcm);
    this.sinceOnsetMs += frameMs;
    if (voiced) {
      this.trailingSilenceMs = 0;
      this.trailingSilenceFrames = 0;
    } else {
      this.trailingSilenceMs += frameMs;
      this.trailingSilenceFrames += 1;
    }
    if (this.trailingSilenceMs >= this.hangoverMs || this.sinceOnsetMs >= this.maxSegmentMs) {
      return this.closeSegment();
    }
    return null;
  }

  // Close the open segment: discard if the voiced portion is below minSpeechMs,
  // else emit preRoll + speech with the trailing hangover silence trimmed off.
  private closeSegment(): Buffer | null {
    const speechMs = this.sinceOnsetMs - this.trailingSilenceMs;
    const keptFrames = this.segment.length - this.trailingSilenceFrames;
    const emit =
      speechMs >= this.minSpeechMs ? Buffer.concat(this.segment.slice(0, keptFrames)) : null;
    this.reset();
    return emit;
  }

  private reset(): void {
    this.inSpeech = false;
    this.segment = [];
    this.preRoll = [];
    this.preRollMsTotal = 0;
    this.sinceOnsetMs = 0;
    this.trailingSilenceMs = 0;
    this.trailingSilenceFrames = 0;
  }
}
