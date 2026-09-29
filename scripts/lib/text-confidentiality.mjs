// Pure rule behind `npm run lint:text-confidentiality` (VW-497).
//
// ESLint's `voltras/no-protocol-detail` only sees the files ESLint parses, so
// markdown, site sources and the non-.mjs scripts were outside every source-level
// scan. This runs the rule's own detector over the raw text of those files, so
// there is one definition of a forbidden shape, not two.
//
// Exemptions use the rule's own directive, written inside whatever comment the
// file type has (an HTML comment in markdown). Only the line and next-line forms
// are honoured, and a directive without a `-- reason` is ignored, so every
// exemption stays enumerable by the pinned list in no-protocol-detail.test.ts.
//
// Like the rule, it never reports the matched token: only path, line, column and
// the kind of shape.

import { findProtocolDetail } from '../../eslint-rules/no-protocol-detail.mjs';

const DIRECTIVE = /eslint-disable-(next-line|line)\s+voltras\/no-protocol-detail\s+--\s+\S/;

const BINARY_EXTENSION =
  /\.(png|jpe?g|gif|webp|ico|mp4|m4a|mp3|wav|onnx|woff2?|ttf|otf|pdf|zip|gz|sqlite)$/i;

/** Paths the text pass skips, each with the reason a reviewer accepted. */
export const SKIPPED_PATHS = [
  {
    // Test fixtures are exempt by path until w5-13, as in eslint.config.mjs.
    matches: (path) => /(^|\/)__tests__\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path),
    reason: 'test fixture',
  },
  {
    matches: (path) => /(^|\/)package-lock\.json$/.test(path),
    reason: 'integrity hashes written by npm',
  },
  {
    matches: (path) => path === 'site/public/captures/manifest.json',
    reason: 'content hashes written by npm run docs:captures',
  },
  {
    matches: (path) => path === 'eslint-rules/no-protocol-detail.mjs',
    reason: 'the rule itself, which illustrates each shape with a synthetic example',
  },
  {
    // One policy line names the private research tree; its reword is queued for the owner (VW-497).
    matches: (path) => path === 'CLAUDE.md' || path === 'AGENTS.md',
    reason: 'repo instructions, reword pending owner review',
  },
];

/** Whether the text pass reads `path` at all. */
export function isScanned(path) {
  if (BINARY_EXTENSION.test(path)) return false;
  return !SKIPPED_PATHS.some(({ matches }) => matches(path));
}

/** Zero-based line numbers a directive exempts. */
function exemptLines(lines) {
  const exempt = new Set();
  lines.forEach((line, index) => {
    const directive = DIRECTIVE.exec(line);
    if (directive) exempt.add(directive[1] === 'line' ? index : index + 1);
  });
  return exempt;
}

/**
 * Every unexempted finding in `text`, as `{ line, column, kind }` (both 1-based).
 */
export function scanText(text) {
  const lines = text.split('\n');
  const exempt = exemptLines(lines);
  const lineStarts = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const findings = [];
  for (const { kind, index } of findProtocolDetail(text)) {
    const lineIndex = lineStarts.findLastIndex((start) => start <= index);
    if (exempt.has(lineIndex)) continue;
    findings.push({ line: lineIndex + 1, column: index - lineStarts[lineIndex] + 1, kind });
  }
  return findings;
}
