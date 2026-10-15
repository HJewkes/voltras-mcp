// @vitest-environment happy-dom
//
// The fidelity overlay mounted with `react-dom/client` (VW-798, VW-431 S3): it starts off,
// toggles from the pill and the keyboard, and its legend follows mounts and unmounts.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { STORAGE_KEY } from '../spa/dev/fidelity/overlay-model.js';
import { FidelityOverlay } from '../spa/dev/fidelity/overlay.js';
import { noteUninstrumented } from '../spa/dev/fidelity/registry.js';
import { withProvenance } from '../spa/dev/fidelity/with-provenance.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = 'src/dashboard/spa/goals/Example.tsx';
const Tile = withProvenance((props: { label: string }) => createElement('div', null, props.label), {
  kind: 'spa',
  name: 'ExampleTile',
  source: SOURCE,
});

const hosts: { root: Root; host: HTMLDivElement }[] = [];

function mount(): Root {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  hosts.push({ root, host });
  return root;
}

/** Renders and lets the overlay's batched registry notification land. */
async function settle(work: () => void): Promise<void> {
  await act(async () => {
    work();
    await Promise.resolve();
  });
}

const query = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
const spaInstances = () =>
  Number(query('fidelity-legend-spa')?.querySelector('[data-testid="instances"]')?.textContent);

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(async () => {
  await settle(() => hosts.forEach(({ root }) => root.unmount()));
  hosts.splice(0).forEach(({ host }) => host.remove());
});

describe('FidelityOverlay', () => {
  it('starts off: the pill shows, but no legend and no outlines', async () => {
    await settle(() => mount().render(createElement(FidelityOverlay)));

    expect(query('fidelity-pill')?.getAttribute('aria-pressed')).toBe('false');
    expect(query('fidelity-pill')?.textContent).toContain('FIDELITY BUILD');
    expect(query('fidelity-legend')).toBeNull();
    expect(query('fidelity-outlines')).toBeNull();
  });

  it('toggles from the pill, persists per tab, and toggles back on Alt+Shift+F', async () => {
    await settle(() => mount().render(createElement(FidelityOverlay)));

    await settle(() => (query('fidelity-pill') as HTMLButtonElement).click());
    expect(query('fidelity-legend')).not.toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('1');

    const shortcut = { altKey: true, shiftKey: true, code: 'KeyF', key: 'F' };
    await settle(() => window.dispatchEvent(new KeyboardEvent('keydown', shortcut)));
    expect(query('fidelity-legend')).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('0');
  });

  it('keeps the legend counts in step with a mount and an unmount', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, '1');
    await settle(() => mount().render(createElement(FidelityOverlay)));
    const before = spaInstances();
    const app = mount();

    await settle(() =>
      app.render(
        createElement('main', null, [
          createElement(Tile, { key: 'a', label: 'Squat' }),
          createElement(Tile, { key: 'b', label: 'Row' }),
        ]),
      ),
    );
    expect(spaInstances()).toBe(before + 2);
    expect(query('fidelity-legend')?.textContent).toContain('titan promotion candidates');
    expect(query('fidelity-legend')?.textContent).toContain(`ExampleTile ${SOURCE}`);

    await settle(() => app.render(null));
    expect(spaInstances()).toBe(before);
  });

  it('lists uninstrumented components apart from the promotion candidates', async () => {
    noteUninstrumented(SOURCE, ['StatRow']);
    window.sessionStorage.setItem(STORAGE_KEY, '1');

    await settle(() => mount().render(createElement(FidelityOverlay)));

    const legend = query('fidelity-legend')?.textContent ?? '';
    expect(legend).toContain('not instrumented');
    expect(legend.slice(legend.indexOf('not instrumented'))).toContain(`StatRow ${SOURCE}`);
  });
});
