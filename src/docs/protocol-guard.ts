// Shape-based detector for device-protocol identifiers, used by the capability
// reference generator. The documentation-side sibling of ESLint's NF-07 rule:
// the site at https://hjewkes.github.io/voltras-mcp/ is public, and the vendor
// shared the protocol informally, so no byte literal, opcode, offset or
// register name may be published.
//
// Detection is by SHAPE and the comparison is NORMALIZED — case folded and
// separators dropped — so `BP_BASE_WEIGHT`, `bp_base_weight`, `BP.BASE.WEIGHT`
// and `bpBaseWeight` are one token to this module, not four. A guard that only
// recognises the spelling it was written against is a hardcoded list wearing a
// regex costume.
//
// What is deliberately NOT covered, and why:
//
//   - All-lowercase and sentence-capitalised HYPHENATED tokens ("back-fill",
//     "Read-only", "self-report"). In English prose `-` is the compound-modifier
//     hyphen: it occurs 236 times across these pages as ordinary language, and
//     no rule separates `back-fill` from a hypothetical `bp-base-weight`. An
//     ALL-CAPS hyphenated token is still flagged, because prose does not shout.
//   - Bare hex runs shorter than 4 characters. `\b[0-9a-f]{2}\b` matches "a1",
//     "42" and every two-digit number in the corpus. Short runs are caught by
//     the byte-sequence rule instead, which needs three of them in a row.
//
// What is deliberately accepted as noise: a bare hex run is indistinguishable
// from a truncated UUID or git SHA, so both are flagged. A page that genuinely
// needs to show one costs a reviewed allowlist entry; a register value that
// slips through costs a confidentiality commitment.

/** What a redacted protocol token is replaced with in generated prose. */
export const REDACTION_MARKER = '[redacted]';

/**
 * Prefixes that make an identifier public by construction, compared after
 * normalization. Both name environment variables this repo documents.
 */
const PUBLIC_PREFIXES = ['vmcp', 'voltra'] as const;

/**
 * Public identifiers that no derivation reaches: error codes a caller handles
 * and internal constants a description cites so a reader can find them. Stored
 * normalized, so every casing and separator spelling of each is covered.
 *
 * This list is a fallback, not the mechanism. The generator derives most of the
 * vocabulary from the live tool schemas, the registry and the public docs.
 */
const PUBLIC_IDENTIFIERS = [
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
  'COERCION_WINDOW_MS',
  'DEFAULT_CONSISTENCY_SCHEME',
  'DEFAULT_PARTIAL_REP_SCHEME',
  'SHAPE_ONLY',
];

/** Case folded, separators dropped: the form every comparison happens in. */
export function normalizeIdentifier(token: string): string {
  return token.toLowerCase().replace(/[_.-]/g, '');
}

interface ProtocolPattern {
  readonly kind: string;
  readonly regexp: RegExp;
  /** Identifier patterns consult the vocabulary; literal ones never do. */
  readonly checksVocabulary: boolean;
  /** Shortest token this pattern reports, when a short match is always noise. */
  readonly minimumLength?: number;
}

const PATTERNS: readonly ProtocolPattern[] = [
  {
    kind: 'byte-sequence',
    regexp: /\b(?:[0-9a-f]{2}[ ,:-]){2,}[0-9a-f]{2}\b/gi,
    checksVocabulary: false,
  },
  { kind: 'hex-literal', regexp: /\b0x[0-9a-f]+\b/gi, checksVocabulary: false },
  {
    kind: 'bare-hex',
    regexp: /(?<![\w.-])(?=[0-9a-f]{4,}(?![\w.-]))(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{4,}/gi,
    checksVocabulary: false,
  },
  {
    kind: 'register-name',
    regexp: /\b[A-Za-z0-9]{2,}(?:[_.][A-Za-z0-9]{2,})+\b|\b[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+\b/g,
    checksVocabulary: true,
  },
  // camelCase and PascalCase. The leading segment must carry a lowercase
  // letter, which keeps bare acronyms (BLE, MCP, SDK) out; four characters
  // minimum, because a two- or three-character run is a fragment of something
  // else, most often a character class inside a quoted regex.
  {
    kind: 'register-name',
    regexp: /\b[A-Z]?[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g,
    checksVocabulary: true,
    minimumLength: 4,
  },
];

/** Shapes that are structurally not identifiers, whatever they normalize to. */
const STRUCTURAL_REJECTS: readonly RegExp[] = [
  /^\d{4}-\d{2}-\d{2}$/, // a date
  /^\d+(?:[._-][\dx]+)+$/i, // a version or a decimal
  /^[A-Za-z]{1,6}[-.]\d/, // a ticket id: VW-116, VMCP-02.16, Bug-22
  /\.(?:ts|tsx|js|mjs|cjs|json|md|sh|yml|sqlite|com|org|io|en|cpp)$/i, // a file or host
];

export interface ProtocolMatch {
  readonly kind: string;
  readonly token: string;
  readonly start: number;
  readonly end: number;
}

export interface ProtocolGuard {
  find(text: string): ProtocolMatch[];
  redact(text: string): { text: string; count: number };
}

function isStructurallyRejected(token: string): boolean {
  return STRUCTURAL_REJECTS.some((pattern) => pattern.test(token));
}

/** Non-overlapping spans covering every match, so one splice pass suffices. */
function mergeSpans(matches: readonly ProtocolMatch[]): { start: number; end: number }[] {
  const merged: { start: number; end: number }[] = [];
  for (const match of matches) {
    const last = merged[merged.length - 1];
    if (last && match.start <= last.end) last.end = Math.max(last.end, match.end);
    else merged.push({ start: match.start, end: match.end });
  }
  return merged;
}

/**
 * Build a guard over `publicVocabulary` — identifiers the caller has derived
 * from the live tool schemas, the registry and the project's public docs. Any
 * identifier-shaped token outside it is treated as protocol detail.
 */
export function createProtocolGuard(publicVocabulary: Iterable<string>): ProtocolGuard {
  const vocabulary = new Set(PUBLIC_IDENTIFIERS.map(normalizeIdentifier));
  for (const entry of publicVocabulary) vocabulary.add(normalizeIdentifier(entry));

  // Markdown escaping truncates a token mid-name (`device.set_isokinetic_\*`
  // leaves `device.set`), so a token that opens a known identifier is public
  // too. Long enough to be a real prefix, not an accidental one.
  const PREFIX_FLOOR = 6;
  const opensAKnownIdentifier = (normalized: string): boolean =>
    normalized.length >= PREFIX_FLOOR &&
    [...vocabulary].some((entry) => entry.startsWith(normalized));

  const isPublic = (token: string): boolean => {
    const normalized = normalizeIdentifier(token);
    if (vocabulary.has(normalized)) return true;
    if (PUBLIC_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
    return opensAKnownIdentifier(normalized);
  };

  const find = (text: string): ProtocolMatch[] => {
    const matches: ProtocolMatch[] = [];
    for (const { kind, regexp, checksVocabulary, minimumLength } of PATTERNS) {
      for (const found of text.matchAll(regexp)) {
        const token = found[0];
        if (minimumLength !== undefined && token.length < minimumLength) continue;
        if (isStructurallyRejected(token)) continue;
        if (checksVocabulary && isPublic(token)) continue;
        matches.push({ kind, token, start: found.index, end: found.index + token.length });
      }
    }
    return matches.sort((a, b) => a.start - b.start || b.end - a.end);
  };

  return {
    find,
    redact(text: string) {
      const spans = mergeSpans(find(text));
      if (spans.length === 0) return { text, count: 0 };
      let out = '';
      let cursor = 0;
      for (const span of spans) {
        out += text.slice(cursor, span.start) + REDACTION_MARKER;
        cursor = span.end;
      }
      return { text: out + text.slice(cursor), count: spans.length };
    },
  };
}
