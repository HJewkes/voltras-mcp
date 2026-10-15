import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { findEncodedValues } from '../../docs/protocol-guard.js';
import { COMPOSER_FRAGMENTS, REDUCED_SCOPE_MINUTES } from '../composer.js';
import {
  COACH_FRAGMENTS,
  type FragmentCandidate,
  validateFragment,
  validateRegistry,
  validateSource,
} from '../fragments.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../..');

// One file per slice joins this list as its prose moves into the registry.
const GUARDED_FILES = [
  'accountability/copy.ts',
  'accountability/composer.ts',
  'voice/cue-templates.ts',
  'dashboard/spa/live-page/live-copy.ts',
  'dashboard/spa/goals/calibration-copy.ts',
];
const PROSE_WORD_FLOOR = 4;

const VALID: FragmentCandidate = {
  id: 'fixture.line',
  text: 'A fixture line for the validator.',
  sourceKind: 'engineering-default',
  sourceRef: 'A fixture reason long enough to count as a sentence.',
};

function isErrorConstruction(node: ts.Node): boolean {
  return ts.isNewExpression(node) && node.expression.getText() === 'Error';
}

// An error message is for the caller, not the lifter, so the scan skips it.
function literalTexts(node: ts.Node, found: string[] = []): string[] {
  if (isErrorConstruction(node)) return found;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
  if (ts.isTemplateExpression(node)) {
    found.push([node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' '));
  }
  ts.forEachChild(node, (child) => void literalTexts(child, found));
  return found;
}

function proseLiterals(relativePath: string): string[] {
  const path = join(SRC, relativePath);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  return literalTexts(source).filter((text) => text.trim().split(/\s+/).length >= PROSE_WORD_FLOOR);
}

describe('every coach fragment carries a source', () => {
  it.each(COACH_FRAGMENTS.map((fragment) => [fragment.id, fragment] as const))(
    '%s has a valid kind and ref',
    (_id, fragment) => {
      expect(validateFragment(fragment)).toEqual([]);
    },
  );

  it('labels the rest extension an engineering default pointing at rest-defaults', () => {
    const fragment = COACH_FRAGMENTS.find(({ id }) => id === 'live.rest-basis.extended');
    expect(fragment).toMatchObject({ sourceKind: 'engineering-default' });
    expect(fragment?.sourceRef).toContain('rest-defaults.ts');
  });

  it('holds no duplicate ids across the registry', () => {
    expect(validateRegistry(COACH_FRAGMENTS)).toEqual([]);
  });

  it('carries no protocol-shaped value in any text or ref', () => {
    const leaks = COACH_FRAGMENTS.flatMap((fragment) =>
      findEncodedValues(`${fragment.text}\n${fragment.sourceRef}`).map(
        (match) => `${fragment.id}: ${match.token}`,
      ),
    );
    expect(leaks).toEqual([]);
  });

  it('pins every fragment text and source, so a wording change is a reviewed snapshot diff', () => {
    const pinned = Object.fromEntries(
      COACH_FRAGMENTS.map(({ id, text, sourceKind, sourceRef }) => [
        id,
        { text, sourceKind, sourceRef },
      ]),
    );
    expect(pinned).toMatchSnapshot();
  });

  it('keeps both DOIs on the if-then paper ref', () => {
    const dois = (ref: string) => ref.match(/10\.\d{4,9}\/[^\s;]+/g);
    for (const fragment of [COMPOSER_FRAGMENTS.ifThenFirst, COMPOSER_FRAGMENTS.ifThenRepeat]) {
      expect(dois(fragment.sourceRef)).toEqual([
        '10.1371/journal.pone.0206294',
        '10.1080/17437199.2011.560095',
      ]);
    }
  });

  it('sources the reduced-scope re-entry minutes', () => {
    const { sourceKind, sourceRef } = REDUCED_SCOPE_MINUTES;
    expect(validateSource(sourceKind, sourceRef)).toEqual([]);
  });
});

describe('the validator rejects an unsourced fragment', () => {
  it('accepts the well-formed fixture', () => {
    expect(validateFragment(VALID)).toEqual([]);
  });

  it('fails a fragment with no source kind', () => {
    const { sourceKind: _omitted, ...noKind } = VALID;
    expect(validateFragment(noKind)).toContain('sourceKind is missing or unknown');
  });

  it('fails a fragment with an empty source ref', () => {
    expect(validateFragment({ ...VALID, sourceRef: '  ' })).toContain('sourceRef is empty');
  });

  it('fails a paper ref that carries no DOI or URL', () => {
    const paper = { ...VALID, sourceKind: 'paper', sourceRef: 'Someone et al. 2020' };
    expect(validateFragment(paper)).toContain('paper ref carries no DOI or URL');
  });

  it('fails a paper ref when any one of its citations carries no DOI or URL', () => {
    const paper = {
      ...VALID,
      sourceKind: 'paper',
      sourceRef: 'Someone et al. 2020, https://doi.org/10.1000/fixture; Another et al. 2021',
    };
    expect(validateFragment(paper)).toContain('paper ref carries no DOI or URL');
  });

  it('fails a paper ref when any one of its citations names no year', () => {
    const paper = {
      ...VALID,
      sourceKind: 'paper',
      sourceRef:
        'Someone et al. 2020, https://doi.org/10.1000/a; Another, https://doi.org/10.1000/b',
    };
    expect(validateFragment(paper)).toContain('paper ref names no year');
  });

  it('fails an rp ref that is not a corpus id', () => {
    const rp = { ...VALID, sourceKind: 'rp', sourceRef: 'RP ghost protocol' };
    expect(validateFragment(rp)).toEqual(['rp ref is not a corpus id: RP ghost protocol']);
  });

  it('fails an rp ref list when any one entry is not a corpus id', () => {
    const rp = { ...VALID, sourceKind: 'rp', sourceRef: 'rp-s10-real-id, S11 disruption rules' };
    expect(validateFragment(rp)).toEqual(['rp ref is not a corpus id: S11 disruption rules']);
  });

  it('fails a ticket-shaped kind whose ref is not a ticket id', () => {
    const ruling = { ...VALID, sourceKind: 'owner-ruling', sourceRef: 'the owner said so' };
    expect(validateFragment(ruling)).toContain('owner-ruling ref is not a ticket id');
  });

  it('fails an engineering default given as a bare tag', () => {
    expect(validateFragment({ ...VALID, sourceRef: 'default' })).toContain(
      'engineering-default ref must be a sentence giving the reason',
    );
  });

  it('fails a ref that points into a private location', () => {
    const local = { ...VALID, sourceRef: 'See ~/notes/why-this-wording for the reasoning here.' };
    expect(validateFragment(local)).toContain('sourceRef points into a private location');
  });

  it('fails a ref that is an absolute path', () => {
    const local = { ...VALID, sourceRef: 'See /opt/notes/why-this-wording for the reasoning.' };
    expect(validateFragment(local)).toContain('sourceRef points into a private location');
  });

  it('names the duplicated id', () => {
    expect(validateRegistry([VALID, VALID])).toEqual(['fixture.line: duplicate id']);
  });
});

describe('guarded modules hold no prose outside the registry', () => {
  it.each(GUARDED_FILES)('%s has no literal of four or more words', (file) => {
    expect(proseLiterals(file)).toEqual([]);
  });

  it('the scan finds prose in a file that still holds it', () => {
    expect(proseLiterals('coach-copy/accountability.ts').length).toBeGreaterThan(0);
  });
});
