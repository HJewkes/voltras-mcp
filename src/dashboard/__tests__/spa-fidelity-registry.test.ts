// @vitest-environment happy-dom
//
// The fidelity overlay's mount registry and provenance wrapper (VW-796, VW-431 S1),
// mounted with `react-dom/client`. A wrapper that changed the DOM, dropped a prop or
// lost a ref would break titan parents in the fidelity build, so each is proven here.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  act,
  Children,
  cloneElement,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { register, snapshot, subscribe, type FidelityEntry } from '../spa/dev/fidelity/registry.js';
import {
  MARKER_END_ATTR,
  MARKER_START_ATTR,
  withProvenance,
} from '../spa/dev/fidelity/with-provenance.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface BadgeProps {
  label: string;
  tone?: string;
  testID?: string;
}

const Badge = forwardRef<HTMLButtonElement, BadgeProps>(function Badge(props, ref) {
  return createElement(
    'button',
    { ref, 'data-tone': props.tone ?? 'none', 'data-testid': props.testID },
    createElement('strong', null, props.label),
  );
});

/** Stands in for a titan parent that clones its child with an injected prop. */
function ToneInjector({ children }: { children: ReactNode }) {
  return createElement(
    'div',
    { className: 'row' },
    Children.map(children, (child) =>
      isValidElement<BadgeProps>(child) ? cloneElement(child, { tone: 'accent' }) : child,
    ),
  );
}

const WrappedBadge = withProvenance(Badge, {
  kind: 'titan',
  name: 'Badge',
  source: '@titan-design/react-ui',
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function withoutMarkers(html: HTMLElement): string {
  const clone = html.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(`[${MARKER_START_ATTR}], [${MARKER_END_ATTR}]`).forEach((marker) => {
    marker.remove();
  });
  return clone.innerHTML;
}

describe('withProvenance', () => {
  it('renders the same DOM as the unwrapped component apart from two hidden markers', () => {
    render(createElement(ToneInjector, null, createElement(Badge, { label: 'Squat' })));
    const plain = container.innerHTML;

    render(createElement(ToneInjector, null, createElement(WrappedBadge, { label: 'Squat' })));

    expect(withoutMarkers(container)).toBe(plain);
    const start = container.querySelector<HTMLElement>(`[${MARKER_START_ATTR}]`);
    const end = container.querySelector<HTMLElement>(`[${MARKER_END_ATTR}]`);
    expect(start?.hidden).toBe(true);
    expect(end?.hidden).toBe(true);
    expect(start?.getAttribute(MARKER_START_ATTR)).toBe(end?.getAttribute(MARKER_END_ATTR));
    expect(start?.nextElementSibling?.tagName).toBe('BUTTON');
    expect(end?.previousElementSibling?.tagName).toBe('BUTTON');
  });

  it('passes a ref and a cloneElement-injected prop through to the inner component', () => {
    const ref = createRef<HTMLButtonElement>();

    render(createElement(ToneInjector, null, createElement(WrappedBadge, { label: 'Row', ref })));

    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.dataset.tone).toBe('accent');
  });

  it('registers each mounted instance and drops the count on unmount', () => {
    const before = snapshot().kinds.titan.instances;
    render(
      createElement(
        'div',
        null,
        createElement(WrappedBadge, { label: 'A', testID: 'badge-a' }),
        createElement(WrappedBadge, { label: 'B' }),
      ),
    );

    expect(snapshot().kinds.titan.instances).toBe(before + 2);
    expect(snapshot().kinds.titan.names).toContain('Badge');
    const tagged = snapshot().entries.find((entry) => entry.testID === 'badge-a');
    expect(tagged).toMatchObject({
      kind: 'titan',
      name: 'Badge',
      source: '@titan-design/react-ui',
    });

    render(createElement('div', null, createElement(WrappedBadge, { label: 'A' })));
    expect(snapshot().kinds.titan.instances).toBe(before + 1);

    render(null);
    expect(snapshot().kinds.titan.instances).toBe(before);
  });
});

describe('fidelity registry', () => {
  const entry = (id: string, kind: FidelityEntry['kind'], name: string): FidelityEntry => ({
    id,
    kind,
    name,
    source: 'src/dashboard/spa/example.tsx',
  });

  it('counts instances per kind and lists each name once', () => {
    const removers = [
      register(entry('a', 'spa', 'PanelCard')),
      register(entry('b', 'spa', 'PanelCard')),
      register(entry('c', 'spa', 'GoalsView')),
      register(entry('d', 'placeholder', 'EmptyStrip')),
    ];

    expect(snapshot().kinds.spa).toEqual({ instances: 3, names: ['GoalsView', 'PanelCard'] });
    expect(snapshot().kinds.placeholder).toEqual({ instances: 1, names: ['EmptyStrip'] });

    removers.forEach((remove) => remove());
    expect(snapshot().kinds.spa).toEqual({ instances: 0, names: [] });
  });

  it('notifies subscribers and keeps the snapshot stable between changes', () => {
    let calls = 0;
    const unsubscribe = subscribe(() => calls++);
    const first = snapshot();
    expect(snapshot()).toBe(first);

    const remove = register(entry('e', 'titan', 'Surface'));
    expect(calls).toBe(1);
    expect(snapshot()).not.toBe(first);

    remove();
    unsubscribe();
    register(entry('f', 'titan', 'Surface'))();
    expect(calls).toBe(2);
  });

  it('is reachable from window.__vmcpFidelity', () => {
    expect(window.__vmcpFidelity?.snapshot).toBe(snapshot);
    expect(window.__vmcpFidelity?.register).toBe(register);
    expect(window.__vmcpFidelity?.subscribe).toBe(subscribe);
  });
});

describe('dev-only boundary', () => {
  it('has no importer of dev/fidelity outside that folder and its own tests', () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const fidelityDir = join('dashboard', 'spa', 'dev', 'fidelity') + sep;
    const files = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(ts|tsx|mts|js|mjs)$/.test(file))
      .filter((file) => !file.startsWith(fidelityDir))
      .filter((file) => !file.includes(`__tests__${sep}spa-fidelity-`));

    const importers = files.filter((file) =>
      /dev\/fidelity/.test(readFileSync(join(srcRoot, file), 'utf8')),
    );

    expect(files).toContain(join('dashboard', 'spa', 'main.tsx'));
    expect(importers).toEqual([]);
  });
});
