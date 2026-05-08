// Unit tests for the voice channel-payload builders. Pinned per the same
// contract as the rep/set/connection payloads — meta keys are XML attributes
// (must all be strings), content body is JSON with a leading `summary` so
// PT Claude can scan-or-drill.

import { describe, expect, it } from 'vitest';

import { buildVoiceInputPayload, buildWakeWordDetectedPayload } from '../channel-payloads.js';

describe('buildWakeWordDetectedPayload', () => {
  it('produces meta with stringified confidence and the wake word', () => {
    const { meta } = buildWakeWordDetectedPayload('hey_jarvis', 0.873, 1715190000000);
    expect(meta).toMatchObject({
      source: 'voltras',
      event_type: 'wake_word_detected',
      wake_word: 'hey_jarvis',
      confidence: '0.873',
    });
    for (const value of Object.values(meta)) {
      expect(typeof value).toBe('string');
    }
  });

  it('rounds confidence to 3 decimals in meta but preserves the raw number in content', () => {
    const { meta, content } = buildWakeWordDetectedPayload('alexa', 0.123456789, 1);
    expect(meta.confidence).toBe('0.123');
    const body = JSON.parse(content) as Record<string, unknown>;
    expect(body.confidence).toBe(0.123456789);
  });

  it('content carries a human-readable summary referencing the wake word', () => {
    const { content } = buildWakeWordDetectedPayload('hey_jarvis', 0.92, 12345);
    const body = JSON.parse(content) as Record<string, unknown>;
    expect(body.summary).toContain('hey_jarvis');
    expect(body.capture_started_at).toBe(12345);
  });
});

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
