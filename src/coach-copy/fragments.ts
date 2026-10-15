// Every coach-facing sentence the code fixes, with where its claim comes from
// (VW-507). A fragment is a template the lifter receives as coaching; its
// `sourceKind` says what kind of evidence stands behind it and `sourceRef`
// points at that evidence in a form a reader can follow without access to any
// private tree.
//
// Pure module with no Node APIs, so the dashboard SPA can import it.

import { ACCOUNTABILITY_FRAGMENT_LIST } from './accountability.js';
import { COMPOSER_FRAGMENT_LIST } from './composer.js';
import { CUE_FRAGMENT_LIST } from './cues.js';
import { DASHBOARD_FRAGMENT_LIST } from './dashboard.js';

/**
 * - `rp`: one or more RP corpus ids, comma separated.
 * - `paper`: author and year, plus a DOI or URL, per citation; citations separated by `;`.
 * - `simulation`: the ticket whose simulation reproduced a stated baseline.
 * - `owner-ruling`: the ticket where the owner ruled on the wording or value.
 * - `engineering-default`: a plain sentence on why it is what it is.
 */
export type SourceKind = 'rp' | 'paper' | 'simulation' | 'owner-ruling' | 'engineering-default';

export const SOURCE_KINDS: readonly SourceKind[] = [
  'rp',
  'paper',
  'simulation',
  'owner-ruling',
  'engineering-default',
];

export interface Fragment {
  /** Dotted lower-case, e.g. `accountability.non-judgment`. */
  readonly id: string;
  /** The template, with its slots as the renderer fills them. */
  readonly text: string;
  readonly sourceKind: SourceKind;
  readonly sourceRef: string;
}

/** A coaching number, rather than a sentence, with the same source fields as a fragment. */
export interface SourcedValue<T> {
  readonly value: T;
  readonly sourceKind: SourceKind;
  readonly sourceRef: string;
}

/** The loosest shape a registry entry can arrive in, so the validator can reject what the type would. */
export interface FragmentCandidate {
  readonly id?: unknown;
  readonly text?: unknown;
  readonly sourceKind?: unknown;
  readonly sourceRef?: unknown;
}

const FRAGMENT_ID = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const RP_ID = /^rp-s\d+-[a-z0-9-]+$/;
const TICKET_ID = /^VW-\d+$/;
const YEAR = /\b(19|20)\d{2}\b/;
const DOI_OR_URL = /(https?:\/\/\S+|\b10\.\d{4,9}\/\S+)/;
// An absolute or home-relative path, or a pointer into the private workspace.
const PRIVATE_LOCATION = /((^|\s)\/\w|~\/|voltras-workspace|\.brain\b|sources\/)/;
const MIN_DEFAULT_REASON_LENGTH = 20;

function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === 'string' && (SOURCE_KINDS as readonly string[]).includes(value);
}

/** A paper ref lists citations separated by `;`, and each one needs its own year and DOI or URL. */
function paperProblem(ref: string): string | undefined {
  const citations = ref.split(';');
  if (!citations.every((citation) => YEAR.test(citation))) return 'paper ref names no year';
  if (!citations.every((citation) => DOI_OR_URL.test(citation))) {
    return 'paper ref carries no DOI or URL';
  }
  return undefined;
}

/** Why `ref` does not fit `kind`, or `undefined` when it does. */
function refProblem(kind: SourceKind, ref: string): string | undefined {
  switch (kind) {
    case 'rp': {
      const bad = ref
        .split(',')
        .map((id) => id.trim())
        .filter((id) => !RP_ID.test(id));
      return bad.length === 0 ? undefined : `rp ref is not a corpus id: ${bad.join(', ')}`;
    }
    case 'paper':
      return paperProblem(ref);
    case 'simulation':
    case 'owner-ruling':
      return TICKET_ID.test(ref) ? undefined : `${kind} ref is not a ticket id`;
    case 'engineering-default':
      return ref.trim().length >= MIN_DEFAULT_REASON_LENGTH && /\s/.test(ref.trim())
        ? undefined
        : 'engineering-default ref must be a sentence giving the reason';
  }
}

/** Every reason a kind and ref pair is not a followable source; empty when it is one. */
export function validateSource(sourceKind: unknown, sourceRef: unknown): string[] {
  const problems: string[] = [];
  if (!isSourceKind(sourceKind)) problems.push('sourceKind is missing or unknown');
  if (typeof sourceRef !== 'string' || sourceRef.trim() === '') {
    problems.push('sourceRef is empty');
    return problems;
  }
  if (PRIVATE_LOCATION.test(sourceRef)) problems.push('sourceRef points into a private location');
  const mismatch = isSourceKind(sourceKind) ? refProblem(sourceKind, sourceRef) : undefined;
  if (mismatch) problems.push(mismatch);
  return problems;
}

/** Every reason `candidate` is not a sourced fragment; empty when it is one. */
export function validateFragment(candidate: FragmentCandidate): string[] {
  const problems: string[] = [];
  const { id, text, sourceKind, sourceRef } = candidate;
  if (typeof id !== 'string' || !FRAGMENT_ID.test(id)) problems.push('id is not dotted lower-case');
  if (typeof text !== 'string' || text.trim() === '') problems.push('text is empty');
  return [...problems, ...validateSource(sourceKind, sourceRef)];
}

/** Problems across a whole registry, each prefixed with the fragment id; duplicate ids included. */
export function validateRegistry(fragments: readonly FragmentCandidate[]): string[] {
  const seen = new Set<unknown>();
  return fragments.flatMap((fragment) => {
    const label = typeof fragment.id === 'string' ? fragment.id : '(no id)';
    const problems = validateFragment(fragment).map((problem) => `${label}: ${problem}`);
    if (seen.has(fragment.id)) problems.push(`${label}: duplicate id`);
    seen.add(fragment.id);
    return problems;
  });
}

/** One list over every per-area registry; later areas append here. */
export const COACH_FRAGMENTS: readonly Fragment[] = [
  ...ACCOUNTABILITY_FRAGMENT_LIST,
  ...COMPOSER_FRAGMENT_LIST,
  ...CUE_FRAGMENT_LIST,
  ...DASHBOARD_FRAGMENT_LIST,
];
