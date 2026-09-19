// Unit tests for the write guard's rule table (VW-500).
//
// One mutant per rule: each case starts from a request that passes every guard
// and breaks exactly one thing, so a rule that stops being enforced fails here
// with the rule's own name rather than as a diffuse route failure.

import { describe, expect, it } from 'vitest';

import {
  bootstrapFetchSiteAllowed,
  checkWriteRequest,
  injectWriteToken,
  isLoopbackHost,
  mintWriteToken,
  WRITE_TOKEN_PLACEHOLDER,
  type WriteGuardHeaders,
} from '../write-guard.js';

const TOKEN = 'a'.repeat(64);

/** A request that passes every guard. Each test breaks exactly one field. */
function goodRequest(overrides: Partial<WriteGuardHeaders> = {}): WriteGuardHeaders {
  return {
    host: '127.0.0.1:7723',
    origin: 'http://127.0.0.1:7723',
    contentType: 'application/json',
    token: TOKEN,
    ...overrides,
  };
}

describe('checkWriteRequest', () => {
  it('admits a same-origin loopback JSON write carrying the token', () => {
    expect(checkWriteRequest(goodRequest(), TOKEN)).toBeNull();
  });

  it('admits the localhost alias and an ephemeral fallback port', () => {
    const request = goodRequest({ host: 'localhost:49312', origin: 'http://localhost:49312' });
    expect(checkWriteRequest(request, TOKEN)).toBeNull();
  });

  it('admits an IPv6 loopback host', () => {
    const request = goodRequest({ host: '[::1]:7723', origin: 'http://[::1]:7723' });
    expect(checkWriteRequest(request, TOKEN)).toBeNull();
  });

  it('refuses a foreign Origin', () => {
    const rejection = checkWriteRequest(goodRequest({ origin: 'https://evil.example' }), TOKEN);
    expect(rejection).toMatchObject({ status: 403, error: 'foreign_origin' });
  });

  it('refuses an Origin that only differs by port', () => {
    const rejection = checkWriteRequest(goodRequest({ origin: 'http://127.0.0.1:9999' }), TOKEN);
    expect(rejection).toMatchObject({ status: 403, error: 'foreign_origin' });
  });

  it('refuses a missing Origin, because a browser always sends one on a write', () => {
    const rejection = checkWriteRequest(goodRequest({ origin: undefined }), TOKEN);
    expect(rejection).toMatchObject({ status: 403, error: 'origin_required' });
  });

  it('refuses the opaque `Origin: null` a sandboxed frame sends', () => {
    const rejection = checkWriteRequest(goodRequest({ origin: 'null' }), TOKEN);
    expect(rejection).toMatchObject({ status: 403, error: 'foreign_origin' });
  });

  it('refuses a non-loopback Host, which is what DNS rebinding produces', () => {
    // A hostile domain resolving to 127.0.0.1 makes Origin and Host AGREE, so
    // the origin rule alone would admit it. The host rule is what refuses it.
    const request = goodRequest({ host: 'rebound.example', origin: 'http://rebound.example' });
    expect(checkWriteRequest(request, TOKEN)).toMatchObject({ status: 403, error: 'foreign_host' });
  });

  it('refuses a missing Host', () => {
    const rejection = checkWriteRequest(goodRequest({ host: undefined }), TOKEN);
    expect(rejection).toMatchObject({ status: 403, error: 'foreign_host' });
  });

  it('refuses the content types a cross-site form post can send', () => {
    for (const contentType of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
      undefined,
    ]) {
      expect(checkWriteRequest(goodRequest({ contentType }), TOKEN)).toMatchObject({
        status: 415,
        error: 'unsupported_media_type',
      });
    }
  });

  it('accepts a JSON content type with parameters and odd casing', () => {
    const request = goodRequest({ contentType: 'Application/JSON; charset=utf-8' });
    expect(checkWriteRequest(request, TOKEN)).toBeNull();
  });

  it('refuses a missing token', () => {
    const rejection = checkWriteRequest(goodRequest({ token: undefined }), TOKEN);
    expect(rejection).toMatchObject({ status: 403, error: 'token_required' });
  });

  it('refuses a token from another boot, and says so as `stale_token`', () => {
    const rejection = checkWriteRequest(goodRequest({ token: 'b'.repeat(64) }), TOKEN);
    expect(rejection).toMatchObject({ status: 403, error: 'stale_token' });
  });

  it('refuses a token of the wrong length rather than comparing it', () => {
    const rejection = checkWriteRequest(goodRequest({ token: TOKEN.slice(0, 32) }), TOKEN);
    expect(rejection).toMatchObject({ status: 403, error: 'stale_token' });
  });

  it('names the outermost failure when several rules are broken at once', () => {
    const request = goodRequest({ host: 'evil.example', origin: 'https://evil.example' });
    expect(checkWriteRequest(request, TOKEN)).toMatchObject({ error: 'foreign_host' });
  });
});

describe('mintWriteToken', () => {
  it('mints a 64-character hex token that differs every call', () => {
    const first = mintWriteToken();
    const second = mintWriteToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });
});

describe('isLoopbackHost', () => {
  it('accepts the loopback names with and without a port', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:7723', 'localhost', 'LOCALHOST:80', '[::1]:7723']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('rejects a LAN address and a domain that merely contains one', () => {
    for (const host of ['192.168.1.20:7723', 'localhost.evil.example', '127.0.0.1.evil.example']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('bootstrapFetchSiteAllowed', () => {
  it('admits a same-origin fetch and a request with no Sec-Fetch-Site at all', () => {
    expect(bootstrapFetchSiteAllowed('same-origin')).toBe(true);
    expect(bootstrapFetchSiteAllowed(undefined)).toBe(true);
  });

  it('refuses a fetch the browser labels cross-site or same-site', () => {
    expect(bootstrapFetchSiteAllowed('cross-site')).toBe(false);
    expect(bootstrapFetchSiteAllowed('same-site')).toBe(false);
  });
});

describe('injectWriteToken', () => {
  it('substitutes every placeholder and leaves the rest of the page alone', () => {
    const html = `<meta content="${WRITE_TOKEN_PLACEHOLDER}"><body>${WRITE_TOKEN_PLACEHOLDER}</body>`;
    expect(injectWriteToken(html, TOKEN)).toBe(`<meta content="${TOKEN}"><body>${TOKEN}</body>`);
  });
});
