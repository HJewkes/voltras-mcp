// Secret scrubbing for the TrueCoach integration.
//
// The password and the bearer token are the only two secrets this integration
// handles, and both travel through code paths that habitually stringify their
// input: `fetch` failures quote the request, SQLite errors quote the row,
// `mapSdkError` copies `err.message` straight into the tool result. So every
// string that can leave this module — every thrown error, every log line —
// goes through `redact()` first.
//
// Substring replacement, not a regex: a password is arbitrary user text and
// building a pattern from it would be an injection of the user's own secret
// into a regex engine. `String.replaceAll` on a string needle has no such
// surface.

export const REDACTED = '[REDACTED]';

/** Below this length a "secret" is common enough text that scrubbing it would mangle unrelated output. */
const MIN_REDACTABLE_LENGTH = 4;

/**
 * Replace every occurrence of every secret in `text` with `[REDACTED]`.
 *
 * Each secret is scrubbed in both its raw form and its percent-encoded form:
 * the password is sent as an `application/x-www-form-urlencoded` field, so an
 * error that echoes the request body carries the encoded spelling, not the raw
 * one.
 */
export function redact(text: string, secrets: Iterable<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length < MIN_REDACTABLE_LENGTH) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join(REDACTED);
    }
  }
  return out;
}

/**
 * Holds the secrets discovered over one import and scrubs on demand.
 *
 * The bearer token is not known until the grant returns, so the set grows
 * mid-run; every call site reads through this object rather than capturing a
 * snapshot of the secrets.
 */
export class SecretRedactor {
  readonly #secrets = new Set<string>();

  add(secret: string | undefined): void {
    if (secret !== undefined && secret.length >= MIN_REDACTABLE_LENGTH) {
      this.#secrets.add(secret);
    }
  }

  text(value: string): string {
    return redact(value, this.#secrets);
  }

  /**
   * A new `Error` carrying the redacted message and the original `code`, so
   * `mapSdkError` still reports a useful code to the tool caller. The cause is
   * deliberately dropped: it is the unredacted original.
   */
  error(err: unknown, fallbackCode: string): Error {
    const message = this.text(err instanceof Error ? err.message : String(err));
    const code =
      err instanceof Error && typeof (err as Error & { code?: unknown }).code === 'string'
        ? (err as Error & { code: string }).code
        : fallbackCode;
    const wrapped = new Error(message);
    (wrapped as Error & { code: string }).code = code;
    return wrapped;
  }
}
