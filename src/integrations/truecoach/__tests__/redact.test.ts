// The redaction contract: neither the password nor the bearer token may
// survive into anything a caller or a log reader can see.

import { describe, expect, it } from 'vitest';
import { redact, REDACTED, SecretRedactor } from '../redact.js';

const PASSWORD = 'hunter2-correct-horse';
const TOKEN = 'tc-access-token-abcdef123456';

describe('redact', () => {
  it('replaces every occurrence of every secret', () => {
    const text = `auth=${TOKEN} pw=${PASSWORD} again=${TOKEN}`;
    const out = redact(text, [PASSWORD, TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(PASSWORD);
    expect(out).toBe(`auth=${REDACTED} pw=${REDACTED} again=${REDACTED}`);
  });

  it('scrubs the percent-encoded spelling a form body would carry', () => {
    const password = 'p@ss word&more';
    const body = `grant_type=password&password=${encodeURIComponent(password)}`;
    expect(redact(body, [password])).not.toContain(encodeURIComponent(password));
  });

  it('leaves text alone when a secret is absent or too short to be one', () => {
    expect(redact('nothing to see', [undefined, 'ab'])).toBe('nothing to see');
  });

  it('treats a regex-special password as a literal, not a pattern', () => {
    const password = 'a.*b+(c)';
    expect(redact(`pw=${password} and axxb`, [password])).toBe(`pw=${REDACTED} and axxb`);
  });
});

describe('SecretRedactor', () => {
  it('strips the token and the password from a thrown error message', () => {
    const redactor = new SecretRedactor();
    redactor.add(PASSWORD);
    redactor.add(TOKEN);
    const original = new Error(`POST failed: password=${PASSWORD} Bearer ${TOKEN}`);
    (original as Error & { code: string }).code = 'ENOTFOUND';

    const wrapped = redactor.error(original, 'TRUECOACH_NETWORK');

    expect(wrapped.message).not.toContain(PASSWORD);
    expect(wrapped.message).not.toContain(TOKEN);
    expect(wrapped.message).toContain(REDACTED);
    expect((wrapped as Error & { code: string }).code).toBe('ENOTFOUND');
  });

  it('falls back to the supplied code and scrubs non-Error throws', () => {
    const redactor = new SecretRedactor();
    redactor.add(TOKEN);
    const wrapped = redactor.error(`raw string carrying ${TOKEN}`, 'TRUECOACH_NETWORK');
    expect(wrapped.message).not.toContain(TOKEN);
    expect((wrapped as Error & { code: string }).code).toBe('TRUECOACH_NETWORK');
  });

  it('scrubs a secret added after the message was composed', () => {
    const redactor = new SecretRedactor();
    redactor.add(TOKEN);
    expect(redactor.text(`Bearer ${TOKEN}`)).toBe(`Bearer ${REDACTED}`);
  });
});
