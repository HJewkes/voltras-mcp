// Render tests for the isometric verdict card (VW-264), same `renderToStaticMarkup`
// technique as `spa-isometric-walkthrough.test.ts`.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IsometricVerdictCard } from '../spa/live-page/IsometricVerdictCard.js';
import type { IsometricVerdictCardModel } from '../spa/live-page/isometric-verdict-model.js';

function card(over: Partial<IsometricVerdictCardModel> = {}): IsometricVerdictCardModel {
  return {
    sides: [
      { label: 'LEFT', peakForceLbs: 180.4 },
      { label: 'RIGHT', peakForceLbs: 151.2 },
    ],
    asymmetryPct: 16.2,
    verdict: 'meaningful',
    reason: 'Asymmetry 16.2% exceeds this athlete’s own intra-limb CV of 4.1%.',
    withheldReason: null,
    ...over,
  };
}

function render(model: IsometricVerdictCardModel | null): string {
  return renderToStaticMarkup(createElement(IsometricVerdictCard, { card: model }));
}

describe('IsometricVerdictCard (VW-264)', () => {
  it('renders nothing without a card', () => {
    expect(render(null)).toBe('');
  });

  it('renders both peaks, the asymmetry and the verdict', () => {
    const html = render(card());
    expect(html).toContain('data-testid="isometric-verdict-card"');
    expect(html).toContain('180.4 lb');
    expect(html).toContain('151.2 lb');
    expect(html).toContain('16.2%');
    expect(html).toContain('LARGER THAN TRIAL-TO-TRIAL SPREAD');
  });

  it('labels a within-spread result as flagged rather than meaningful', () => {
    const html = render(card({ verdict: 'flagged' }));
    expect(html).toContain('WITHIN TRIAL-TO-TRIAL SPREAD');
    expect(html).not.toContain('LARGER THAN TRIAL-TO-TRIAL SPREAD');
  });

  it('prints a dash for a side with no mean peak', () => {
    const html = render(
      card({ sides: [{ label: 'LEFT', peakForceLbs: null }], asymmetryPct: null, verdict: null }),
    );
    expect(html).toContain('—');
    expect(html).not.toContain('data-testid="isometric-verdict-asymmetry"');
  });

  it('shows the withheld reason instead of a verdict when the setup gate confounded it', () => {
    const html = render(
      card({ verdict: null, withheldReason: 'the two sides’ cable travel differs' }),
    );
    expect(html).toContain('Verdict withheld: the two sides’ cable travel differs');
    expect(html).not.toContain('data-testid="isometric-verdict-label"');
  });
});
