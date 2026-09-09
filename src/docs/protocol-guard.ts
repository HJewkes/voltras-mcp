// Shape-based detector for device-protocol identifiers, used by the capability
// reference generator. The documentation-side sibling of ESLint's NF-07 rule:
// the site at https://hjewkes.github.io/voltras-mcp/ is public, and the vendor
// shared the protocol informally, so no byte literal, opcode, offset or
// register name may be published.
//
// Detection is by SHAPE, never by a list of known protocol names — a denylist
// cannot cover a register nobody has written down yet. The inverse list is the
// small one: the public identifiers that happen to share those shapes.

/** What a redacted protocol token is replaced with in generated prose. */
export const REDACTION_MARKER = '[redacted]';

/**
 * Prefixes that make a `SCREAMING_SNAKE` token public by construction. Both
 * name environment variables this repo documents in its own README.
 */
const PUBLIC_PREFIXES = ['VMCP_', 'VOLTRA_'] as const;

/**
 * Public identifiers that a tool description or a doc page cites by name.
 * Every entry is either an MCP error code a caller handles, or the name of an
 * internal constant a description refers to so a reader can find it in source.
 * Neither class describes the wire protocol.
 *
 * A new error code shows up here as a redaction the reference test reports, so
 * adding it is a deliberate act rather than a silent pass-through.
 */
const PUBLIC_IDENTIFIERS = new Set([
  // Error codes returned to callers.
  'ALREADY_IN_DAMPER',
  'DEVICE_NOT_FOUND',
  'GUIDED_LOAD_MODE_MISMATCH',
  'INVALID_INPUT',
  'LEASE_LOST',
  'MOCK_NOT_SUPPORTED',
  'MODE_ECHO_TIMEOUT',
  'NOT_CONFIGURED',
  'NOT_FOUND',
  'NOT_IMPLEMENTED',
  'NOT_IN_GUIDED_LOAD',
  'NO_PERSISTED_BINDING',
  'SET_ALREADY_ACTIVE',
  'SLOT_NOT_BOUND',
  // Internal constant names cited so a reader can locate them in source.
  'COERCION_WINDOW_MS',
  'DEFAULT_CONSISTENCY_SCHEME',
  'DEFAULT_PARTIAL_REP_SCHEME',
  'SHAPE_ONLY',
]);

interface ProtocolPattern {
  readonly kind: string;
  readonly regexp: RegExp;
}

const PATTERNS: readonly ProtocolPattern[] = [
  { kind: 'byte-sequence', regexp: /\b(?:[0-9A-Fa-f]{2}[ ,:-]){2,}[0-9A-Fa-f]{2}\b/g },
  { kind: 'hex-literal', regexp: /\b0x[0-9a-fA-F]+\b/g },
  // A bare uppercase hex run is how this project's protocol notes write an
  // opcode. The same run in lowercase is a UUID or a git SHA, and requiring
  // both a letter and a digit keeps plain words and years out.
  {
    kind: 'opcode',
    regexp: /\b(?=[0-9A-F]{4,}\b)(?=[A-F0-9]*[A-F])(?=[A-F0-9]*[0-9])[A-F0-9]{4,}\b/g,
  },
  { kind: 'register-name', regexp: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g },
];

/** True when `token` is a documented public identifier rather than protocol. */
export function isPublicIdentifier(token: string): boolean {
  return (
    PUBLIC_IDENTIFIERS.has(token) || PUBLIC_PREFIXES.some((prefix) => token.startsWith(prefix))
  );
}

export interface ProtocolMatch {
  readonly kind: string;
  readonly token: string;
  readonly start: number;
  readonly end: number;
}

/** Every protocol-shaped, non-public token in `text`, in source order. */
export function findProtocolTokens(text: string): ProtocolMatch[] {
  const matches: ProtocolMatch[] = [];
  for (const { kind, regexp } of PATTERNS) {
    for (const found of text.matchAll(regexp)) {
      const token = found[0];
      if (isPublicIdentifier(token)) continue;
      matches.push({ kind, token, start: found.index, end: found.index + token.length });
    }
  }
  return matches.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Non-overlapping spans covering every match, so one splice pass suffices. */
function mergeSpans(matches: readonly ProtocolMatch[]): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = [];
  for (const match of matches) {
    const last = merged[merged.length - 1];
    if (last && match.start <= last.end) {
      last.end = Math.max(last.end, match.end);
    } else {
      merged.push({ start: match.start, end: match.end });
    }
  }
  return merged;
}

export interface Redaction {
  readonly text: string;
  readonly count: number;
}

/** Replace every protocol-shaped token in `text` with {@link REDACTION_MARKER}. */
export function redactProtocolTokens(text: string): Redaction {
  const spans = mergeSpans(findProtocolTokens(text));
  if (spans.length === 0) return { text, count: 0 };
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + REDACTION_MARKER;
    cursor = span.end;
  }
  return { text: out + text.slice(cursor), count: spans.length };
}
