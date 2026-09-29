// Source-level confidentiality guard (VW-213). The sibling of the generated-docs
// guard in `src/docs/protocol-guard.ts`: that one runs over the pages the site
// publishes, this one runs over the source those pages are built from, so detail
// is caught where it is written rather than where it escapes.
//
// It is written against SHAPES, not spellings. A rule that only recognises the
// instances it was written against is a hardcoded list wearing a regex costume,
// and this repo has already been bitten by that: three sweeps over the same tree
// returned three different counts because each inherited the previous sweep's
// belief about what the detail looked like.
//
// The whole file text is scanned — code, string literals, JSDoc, block comments
// and TRAILING line comments alike. Trailing comments were the blind spot in
// every hand-rolled sweep, because those patterns anchored on a full-line `//`.
// Scanning the raw text also means a file is never skipped for being classified
// binary; `src/state/coercion-watch.ts` carried a NUL byte for months and every
// `grep -r` in this repo silently walked past it.
//
// What this rule catches and what it cannot:
//
//   - It catches ENCODED VALUES and PROVENANCE. Those have a shape.
//   - It cannot catch PROSE. A sentence naming a register and describing what
//     writing to it does carries no value in any shape a pattern can match.
//     Prose is a review-checklist item (see CLAUDE.md), not a lint rule, and
//     nothing here should be read as covering it.
//   - It folds a CONCATENATION OF STRING LITERALS (VW-224). `'0x' + '1f'` and a
//     line-wrapped `'a9c7' + 'f00d'` are joined, adjacent literal pieces at a
//     time, and scanned as one string. A finding reported this way is one that
//     crosses a join; a finding inside one piece is already reported above.
//
// What it does NOT catch (VW-224):
//
//   - A value built from VARIABLES OR CALLS. `PREFIX + digits`, `[a, b].join()`
//     and `String.fromCharCode(...)` are never evaluated; only adjacent string
//     and expression-free template literals are folded.
//   - PROSE PROVENANCE: a sentence saying where a value came from, or what a
//     register does, without quoting a value or a private path.
//   - DELIBERATE EVASION. Anyone evading the rule can always spell a value in a
//     shape it does not know; the threat model is accidental disclosure.
//
// Naming these limits is the point. A guard that is silently narrower than it
// looks is the failure this campaign is named after: a `[redacted]` marker
// beside surviving prose made an exposure look handled (VW-220).
//
// It never reports the matched token. A CI log is as public as the source it
// refused to accept, so the message names the shape and lets the file, line and
// column say where.

/**
 * Shapes that carry a device value or point at where one was obtained.
 *
 * `hex-literal` requires that `0x` not follow a digit, which is what separates a
 * command code embedded in an identifier (`Cmd0x10`) from a viewport size
 * (`1440x900`); both put `0x` in the middle of a word and only one is a value.
 *
 * `private-provenance` bans paths into trees the reader cannot open. A comment
 * pointing at a document nobody outside this machine can read is a breadcrumb
 * at worst and noise at best.
 */
const TEXT_PATTERNS = [
  { kind: 'hex-literal', regexp: /(?<!\d)0x[0-9a-f]+/gi },
  { kind: 'byte-sequence', regexp: /(?<![\w#])[0-9a-f]{2}(?:[ ,:.-][0-9a-f]{2}){2,}(?![\w-])/gi },
  { kind: 'command-code', regexp: /\bcmd(?:id)?[\s_.:=-]*(?:0x)?[0-9a-f]{2,}\b/gi },
  {
    kind: 'private-provenance',
    regexp: /voltra-private|sources\/research\/|captures\/sessions|decompil|\bVTR-\d/gi,
  },
];

/**
 * A clock or a duration: colon- or dot-separated pairs with no hex letter in
 * any of them. `00:00:00.840` is how the transcriber writes a timestamp and
 * this repo quotes several. Known gap, stated rather than hidden: a byte run
 * spelled with colons and no letters (`55:13:04`) reads as a duration to this
 * rule and is not flagged. Every other separator is.
 */
const CLOCK_SHAPE = /^\d{2}(?:[:.]\d{2})+$/;

/**
 * A source citation naming several lines: decimal, and mixing a range dash with
 * a list comma, where a byte run keeps one separator. The docs guard's
 * `isLineRangeList` draws the same line, so a citation passes both layers.
 */
function isLineRangeList(token) {
  // Known gap, shared with the docs guard: an all-decimal run mixing dash and comma passes.
  return /^\d+(?:[-,]\d+)+$/.test(token) && token.includes('-') && token.includes(',');
}

/**
 * The boundaries a value can hide behind inside an identifier: separators, and
 * the two case transitions. `(?<=[A-Z0-9])(?=[A-Z][a-z])` is what splits
 * `probeA9C7Latch` into `probe` / `A9C7` / `Latch` rather than leaving the run
 * fused to the word after it.
 */
const SEGMENT_BOUNDARY = /[_$]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z0-9])(?=[A-Z][a-z])/;

const HEX_RUN = /^[0-9a-f]{4,}$/i;
const HAS_HEX_LETTER = /[a-f]/i;
const HAS_DIGIT = /\d/;

/**
 * A byte sequence can also be spelled with `_`, and `_` is an identifier
 * separator rather than punctuation, so that spelling is found by segmenting
 * words rather than by widening the punctuation class above. Doing it here is
 * what reaches `frame_a9_c7_00_04` as well as `a9_c7_00_04`; widening the
 * punctuation class reaches only the second, because the run no longer starts
 * at a word boundary once something is prefixed to it.
 */
const HEX_PAIR = /^[0-9a-f]{2}$/i;
const BYTES_IN_A_CAPTURE = 3;

/**
 * A whole identifier segment made of hex characters, long enough to be a
 * capture and carrying both a letter and a digit.
 *
 * WHOLE, deliberately: a hex-shaped run welded to non-hex letters is a word,
 * not a value. That is what separates `A9C7` from the `a256` inside `sha256`
 * and the `90de` inside `-90deg`, and it costs a known gap — a value spelled
 * inside an English word (`probe90de1`) reads as a word to this rule.
 */
function isBareHexRun(segment) {
  return HEX_RUN.test(segment) && HAS_HEX_LETTER.test(segment) && HAS_DIGIT.test(segment);
}

const WORD = /[A-Za-z0-9_$]+/g;

/**
 * A tracking id: `VW-168a`, `VMCP-02`, `SDK-01`. The tail of one is a short run
 * of hex-shaped characters, so without this the repo's own ticket numbers read
 * as captures. Deliberately tight — digits and at most one trailing lowercase
 * letter — so `REG-1A2B` is still a finding.
 */
const TICKET_ID = /(?<![\w-])[A-Z]{2,6}-\d{1,4}[a-z]?(?![\w-])/g;

function ticketSpans(text) {
  return [...text.matchAll(TICKET_ID)].map((m) => [m.index, m.index + m[0].length]);
}

/**
 * Every protocol-shaped span in `text`, as `{ kind, index, length }`.
 *
 * Bare hex runs are found by segmenting identifiers, so `a9c7`, `REG_A9C7` and
 * `probeA9C7Latch` are one finding shape and not three — a value inside an
 * identifier is the same disclosure as a value on its own. A word written
 * straight after `#` is skipped: in this repo that prefix is a CSS colour or a
 * pull-request number, never a device value.
 */
export function findProtocolDetail(text) {
  const findings = [];
  for (const { kind, regexp } of TEXT_PATTERNS) {
    for (const match of text.matchAll(regexp)) {
      if (kind === 'byte-sequence' && (CLOCK_SHAPE.test(match[0]) || isLineRangeList(match[0])))
        continue;
      findings.push({ kind, index: match.index, length: match[0].length });
    }
  }
  const tickets = ticketSpans(text);
  for (const match of text.matchAll(WORD)) {
    if (text[match.index - 1] === '#') continue;
    if (tickets.some(([from, to]) => match.index >= from && match.index < to)) continue;
    const word = match[0];
    let cursor = 0;
    let pairRun = 0;
    for (const segment of word.split(SEGMENT_BOUNDARY)) {
      const at = word.indexOf(segment, cursor);
      if (isBareHexRun(segment)) {
        findings.push({ kind: 'bare-hex', index: match.index + at, length: segment.length });
      }
      pairRun = HEX_PAIR.test(segment) ? pairRun + 1 : 0;
      if (pairRun === BYTES_IN_A_CAPTURE) {
        findings.push({ kind: 'byte-sequence', index: match.index, length: word.length });
      }
      cursor = at + segment.length;
    }
  }
  return findings.sort((a, b) => a.index - b.index);
}

/** A literal's string value, or `null` for anything that would need evaluating. */
function literalText(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked ?? null;
  }
  return null;
}

function isConcatenation(node) {
  return node?.type === 'BinaryExpression' && node.operator === '+';
}

/** The leaves of a `+` chain, left to right. */
function chainOperands(node) {
  if (!isConcatenation(node)) return [node];
  return [...chainOperands(node.left), ...chainOperands(node.right)];
}

/** Runs of adjacent literal pieces, each as its pieces' texts, in source order. */
function literalRuns(operands) {
  const runs = [[]];
  for (const operand of operands) {
    const text = literalText(operand);
    if (text === null) runs.push([]);
    else runs.at(-1).push(text);
  }
  return runs.filter((run) => run.length > 1);
}

/** The first shape that only exists once `pieces` are joined, or `undefined`. */
function shapeAcrossJoin(pieces) {
  const joins = [];
  let offset = 0;
  for (const piece of pieces.slice(0, -1)) joins.push((offset += piece.length));
  return findProtocolDetail(pieces.join('')).find(({ index, length }) =>
    joins.some((join) => join > index && join < index + length),
  );
}

const MESSAGES = {
  'hex-literal': 'a hex literal',
  'byte-sequence': 'a byte sequence',
  'bare-hex': 'a bare hex run',
  'command-code': 'a command code',
  'private-provenance': 'a pointer into a non-public tree',
};

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban device-protocol values and private-tree provenance from source, comments and strings (VW-213).',
    },
    schema: [],
    messages: {
      protocolDetail:
        'This is {{shape}}, which may not appear in source, comments or strings (VW-213). Describe the observable behaviour instead, and keep protocol-derived findings in the private research tree.',
    },
  },
  create(context) {
    return {
      Program() {
        const source = context.sourceCode;
        for (const { kind, index, length } of findProtocolDetail(source.getText())) {
          context.report({
            loc: {
              start: source.getLocFromIndex(index),
              end: source.getLocFromIndex(index + length),
            },
            messageId: 'protocolDetail',
            data: { shape: MESSAGES[kind] },
          });
        }
      },
      BinaryExpression(node) {
        if (node.operator !== '+' || isConcatenation(node.parent)) return;
        const finding = literalRuns(chainOperands(node)).map(shapeAcrossJoin).find(Boolean);
        if (!finding) return;
        context.report({
          node,
          messageId: 'protocolDetail',
          data: { shape: `${MESSAGES[finding.kind]} split across a concatenation` },
        });
      },
    };
  },
};

export default { rules: { 'no-protocol-detail': rule } };
