// Unit tests for the voice channel-payload builders. Pinned per the same
// contract as the rep/set/connection payloads — meta keys are XML attributes
// (must all be strings), content body is JSON with a leading `summary` so
// PT Claude can scan-or-drill.

import { describe, expect, it } from 'vitest';

import { buildVoiceInputPayload } from '../channel-payloads.js';

describe('buildVoiceInputPayload', () => {
  it('puts transcript + latency + STT model into meta as strings', () => {
    const { meta } = buildVoiceInputPayload('switch to rowing', 850, 'base.en', 4200);
    expect(meta).toMatchObject({
      source: 'voltras',
      event_type: 'voice_input',
      latency_ms: '850',
      stt_model: 'base.en',
      audio_duration_ms: '4200',
    });
    for (const value of Object.values(meta)) {
      expect(typeof value).toBe('string');
    }
  });

  it('content keeps numbers numeric and includes the transcript', () => {
    const { content } = buildVoiceInputPayload('switch to rowing', 850, 'base.en', 4200);
    const body = JSON.parse(content) as Record<string, unknown>;
    expect(body).toMatchObject({
      transcript: 'switch to rowing',
      latency_ms: 850,
      stt_model: 'base.en',
      audio_duration_ms: 4200,
    });
    expect(typeof body.summary).toBe('string');
    expect(String(body.summary)).toContain('switch to rowing');
  });

  it('handles empty transcripts without crashing', () => {
    const { meta, content } = buildVoiceInputPayload('', 100, 'tiny.en', 1000);
    expect(meta.event_type).toBe('voice_input');
    const body = JSON.parse(content) as Record<string, unknown>;
    expect(body.transcript).toBe('');
  });
});
