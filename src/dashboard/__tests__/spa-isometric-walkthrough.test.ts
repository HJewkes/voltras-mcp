// Render tests for the isometric-hold walkthrough overlay (VW-198), same
// `renderToStaticMarkup` technique as `spa-display-unit-toggle.test.ts`.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IsometricWalkthrough } from '../spa/live-page/IsometricWalkthrough.js';
import type { LiveIsometricSignal } from '../../state/live-signal.js';

function signal(over: Partial<LiveIsometricSignal> = {}): LiveIsometricSignal {
  return { slot: 'primary', phase: 'ready', trial: 1, holdMs: 5000, side: null, ...over };
}

function render(sig: LiveIsometricSignal | null): string {
  return renderToStaticMarkup(createElement(IsometricWalkthrough, { signal: sig }));
}

describe('IsometricWalkthrough (VW-198)', () => {
  it('renders nothing when no hold is in progress', () => {
    expect(render(null)).toBe('');
  });

  it.each([
    ['ready', 'Get set'],
    ['go', 'Pull now'],
    ['hold', 'Hold max'],
    ['stop', 'Stop and release'],
  ] as const)('renders the %s phase label', (phase, label) => {
    const html = render(signal({ phase }));
    expect(html).toContain('data-testid="isometric-walkthrough"');
    expect(html).toContain(label);
  });

  it('shows the trial number', () => {
    const html = render(signal({ trial: 3 }));
    expect(html).toContain('HOLD 3');
  });

  it('renders the countdown ring only during the hold phase', () => {
    const goHtml = render(signal({ phase: 'go' }));
    const holdHtml = render(signal({ phase: 'hold' }));
    // `useTimer`'s formatted mm:ss readout only exists once the ring mounts.
    expect(goHtml).not.toContain('0:05');
    expect(holdHtml).toContain('0:05');
  });
});
