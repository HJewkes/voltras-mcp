// The repo-wide guard that no code path converts velocity loss directly into
// an RIR claim without going through the fitted per-lifter RIR-velocity model
// (VW-302).
//
// WHY THIS GUARD EXISTS. Jukic, Prnjak, McGuigan & Helms, Eur J Appl Physiol
// 2023: agreement between velocity loss and percentage of max reps completed
// — the thing a "VL% -> RIR" conversion is actually claiming — is unacceptable
// at every load tested, with errors over 10%. Velocity loss is a
// volume-control dial (`velocity-loss holds` closes a set at a threshold);
// it is not a proximity-to-failure estimate, and the only defensible way to
// answer "how many reps in reserve" from velocity is the lifter's OWN fitted
// curve (`analytics/rir-velocity.ts`, VW-298), never a formula or table
// applied straight to a velocity-loss percentage.
//
// WRITTEN AGAINST SHAPES, the same choice `no-protocol-detail.mjs` made and
// for the same reason: a rule that only recognises the instances it was
// written against is a hardcoded list wearing a regex costume. Three shapes
// are covered — a function whose name or return type names RIR and whose
// params name velocity loss, a call into an RIR-named callee carrying a
// velocity-loss argument, and a lookup table named for both — because those
// are the shapes a direct conversion actually takes in this codebase (see
// `estimateRIRWithProfile`, the tracked pre-existing hit below).
//
// It scans RAW TEXT, so it also sees a shape written inside a comment. That
// is deliberate, not a bug to route around: the no-protocol-detail guard
// made the same call for the same reason (see its header), and narrowing
// this one to skip comments would just move a real hit into a doc comment.
//
// WHAT IT CANNOT CATCH: a conversion spread across two functions with no
// shape linking them (an RIR-named function whose OWN param is never named
// for velocity loss, called from a site that computed the loss three lines
// earlier under a different name), or one written entirely in prose with no
// matching identifier. Those are a review-checklist question, not this
// test's job — see CLAUDE.md's confidentiality-guard section, which draws
// the same line for a different guard.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const FIXTURE_PATH = join(SRC_ROOT, '__tests__/fixtures/direct-vl-to-rir.fixture.ts');

/** A quantity naming velocity LOSS — the dial, never the target of a claim. */
const VL_TOKEN = /velocityLoss|vlPct|vLossPct|velLossPct|vl_pct|velocity_loss/i;

/** A quantity naming reps in reserve. */
const RIR_TOKEN = /rir|reps[ _]?in[ _]?reserve/i;

interface Finding {
  kind: 'call' | 'definition' | 'table';
  file: string;
  line: number;
  name: string;
}

/**
 * Files implementing the fitted per-lifter RIR-velocity model itself
 * (VW-298) — the one path licensed to relate a velocity quantity to RIR.
 * None of them currently trip this scanner (the model is fitted on raw
 * velocity against a known RIR anchor, never on a velocity-LOSS percentage),
 * but a hit here would be the model path's own business, not a violation.
 */
const MODEL_PATH_FILES = new Set([
  'src/analytics/rir-velocity.ts',
  'src/tools/rir-velocity-tools.ts',
]);

/**
 * A hit on a line carrying this marker in the two lines above it is a KNOWN,
 * pre-existing conversion this guard was told not to fail CI on. Every
 * marker must also appear in the pinned list below — an exclusion that
 * governs COUNTING must never be trusted without being enumerated, the same
 * rule `no-protocol-detail.test.ts` applies to its own exemption list.
 */
const TRACKED_MARKER = 'VW-302: pre-existing, tracked';

function balancedSpan(text: string, openIndex: number, open: string, close: string): string {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return text.slice(openIndex);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

const NOT_A_CALLEE = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return']);

/** An RIR-named callee invoked with a velocity-loss-named argument. */
function findRirCallsWithVlArgs(text: string): Array<{ index: number; name: string }> {
  const found: Array<{ index: number; name: string }> = [];
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (NOT_A_CALLEE.has(name) || !RIR_TOKEN.test(name)) continue;
    // Skip the declaration site itself (`function estimateRir...(`) — that shape is
    // `findRirDefinitionsWithVlParams`'s job, not this one's, so it is not double-counted.
    if (/function\s*$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    const openIndex = m.index + m[0].length - 1;
    const args = balancedSpan(text, openIndex, '(', ')');
    if (VL_TOKEN.test(args)) found.push({ index: m.index, name });
  }
  return found;
}

const FUNCTION_DECL_RE = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^{;]+?))?\s*\{/g;
const ARROW_DECL_RE =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*([^{=]+?))?\s*=>/g;

/** A function/arrow named or typed for RIR, taking a velocity-loss param. */
function findRirDefinitionsWithVlParams(text: string): Array<{ index: number; name: string }> {
  const found: Array<{ index: number; name: string }> = [];
  for (const re of [FUNCTION_DECL_RE, ARROW_DECL_RE]) {
    for (const m of text.matchAll(re)) {
      const name = m[1];
      const params = m[2];
      const returnType = m[3] ?? '';
      if (!VL_TOKEN.test(params)) continue;
      if (RIR_TOKEN.test(name) || RIR_TOKEN.test(returnType)) found.push({ index: m.index, name });
    }
  }
  return found;
}

const TABLE_DECL_RE =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:new\s+Map\s*\(|\{|\[)/g;

/** A lookup table declared with a name pairing velocity loss and RIR. */
function findVlToRirTables(text: string): Array<{ index: number; name: string }> {
  const found: Array<{ index: number; name: string }> = [];
  for (const m of text.matchAll(TABLE_DECL_RE)) {
    const name = m[1];
    if (VL_TOKEN.test(name) && RIR_TOKEN.test(name)) found.push({ index: m.index, name });
  }
  return found;
}

function scanText(text: string, relPath: string): Finding[] {
  const findings: Finding[] = [];
  for (const { index, name } of findRirCallsWithVlArgs(text)) {
    findings.push({ kind: 'call', file: relPath, line: lineOf(text, index), name });
  }
  for (const { index, name } of findRirDefinitionsWithVlParams(text)) {
    findings.push({ kind: 'definition', file: relPath, line: lineOf(text, index), name });
  }
  for (const { index, name } of findVlToRirTables(text)) {
    findings.push({ kind: 'table', file: relPath, line: lineOf(text, index), name });
  }
  return findings.sort((a, b) => a.line - b.line);
}

function scanFile(absPath: string): Finding[] {
  return scanText(readFileSync(absPath, 'utf8'), relative(REPO_ROOT, absPath));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** Whether a marked exception covers the two lines above `line` in `text`. */
function trackedAt(text: string, line: number): boolean {
  const lines = text.split('\n');
  const window = lines.slice(Math.max(0, line - 3), line).join('\n');
  return window.includes(TRACKED_MARKER);
}

describe('VW-302 — velocity loss never converts straight to an RIR claim', () => {
  it('finds only the fitted model path or a tracked, marked exception across src/', () => {
    const findings = sourceFiles(SRC_ROOT).flatMap((file) => scanFile(file));
    const unexplained = findings.filter((f) => {
      if (MODEL_PATH_FILES.has(f.file)) return false;
      const text = readFileSync(join(REPO_ROOT, f.file), 'utf8');
      return !trackedAt(text, f.line);
    });

    expect(unexplained).toEqual([]);
  });
});

describe('positive control — the scanner is not blind', () => {
  it('catches the deliberately planted conversion in the fixture, in every shape', () => {
    const findings = scanFile(FIXTURE_PATH);

    expect(findings.map((f) => f.kind).sort()).toEqual(['call', 'definition', 'table']);
  });
});

describe('the tracked-exception marker', () => {
  // Same discipline as `no-protocol-detail.test.ts`'s exemption-list test: an
  // exclusion that governs the first test above must be enumerated here, so
  // a marker cannot appear without someone editing this list and saying why.
  //
  // ZERO, as of VW-310. The two tracked hits this list used to carry
  // (`estimateRIRWithProfile` calls in `metrics-tools.ts`'s `rirForSet` and
  // `report-tools.ts`'s `rirLineForExercise`) are gone: both call sites now
  // go through `rir-velocity-tools.ts`'s `estimateRepRir`, which tries the
  // fitted per-lifter curve (VW-298) first and only falls back to
  // `estimateRIRWithProfile` — still a direct velocity-loss-to-RIR
  // conversion by shape, but one that now lives inside `MODEL_PATH_FILES`,
  // the one path this guard already treats as the fitted model's own
  // business. See CHANGELOG.
  it('carries no tracked exceptions', () => {
    const sites: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(REPO_ROOT, file);
      text.split('\n').forEach((line, i) => {
        if (line.includes(TRACKED_MARKER)) sites.push(`${rel}:${String(i + 1)}`);
      });
    }

    expect(sites).toEqual([]);
  });
});
