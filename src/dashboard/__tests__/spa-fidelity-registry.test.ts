// @vitest-environment happy-dom
//
// The fidelity overlay's mount registry and provenance wrapper (VW-796, VW-431 S1),
// mounted with `react-dom/client`. A wrapper that changed the DOM, dropped a prop or
// lost a ref would break titan parents in the fidelity build, so each is proven here.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/** Relative import and re-export specifiers of one module, resolved to files under `srcRoot`. */
function localImports(srcRoot: string, file: string): string[] {
  const text = readFileSync(join(srcRoot, file), 'utf8');
  const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1]!,
  );
  return specifiers.flatMap((specifier) => {
    if (!specifier.startsWith('.')) return specifier.includes('dev/fidelity') ? [specifier] : [];
    const base = join(dirname(file), specifier).replace(/\.js$/, '');
    const candidates = ['', '.ts', '.tsx', `${sep}index.ts`, `${sep}index.tsx`].map(
      (ext) => base + ext,
    );
    return candidates.filter((candidate) => existsSync(join(srcRoot, candidate))).slice(0, 1);
  });
}

const FIDELITY_DIR = join('dashboard', 'spa', 'dev', 'fidelity') + sep;
// The build config loads the plugin, which itself imports nothing the browser bundle sees.
const ALLOWED_EDGE = {
  from: join('dashboard', 'spa', 'vite.config.ts'),
  to: `${FIDELITY_DIR}vite-plugin.ts`,
};

/** Modules outside dev/fidelity that reach it, directly or through any chain of local imports. */
function reachesFidelity(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const tainted = new Set<string>();
  const isFidelity = (to: string): boolean =>
    to.includes('dev/fidelity') || to.startsWith(FIDELITY_DIR);
  const taints = (from: string, to: string): boolean =>
    (isFidelity(to) || tainted.has(to)) && !(from === ALLOWED_EDGE.from && to === ALLOWED_EDGE.to);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, imports] of graph) {
      if (tainted.has(file) || file.startsWith(FIDELITY_DIR)) continue;
      if (!imports.some((to) => taints(file, to))) continue;
      tainted.add(file);
      grew = true;
    }
  }
  return [...tainted].sort();
}

describe('dev-only boundary', () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  it('has no importer of dev/fidelity outside that folder apart from the build config', () => {
    const files = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(ts|tsx|mts|js|mjs)$/.test(file))
      .filter((file) => !file.includes(`__tests__${sep}spa-fidelity-`));
    const graph = new Map(files.map((file) => [file, localImports(srcRoot, file)]));

    expect(files).toContain(join('dashboard', 'spa', 'main.tsx'));
    expect(graph.get(ALLOWED_EDGE.from)).toContain(ALLOWED_EDGE.to);
    expect(reachesFidelity(graph)).toEqual([]);
  });

  it('catches a sibling under spa/dev and a two-hop re-export through it', () => {
    const devIndex = join('dashboard', 'spa', 'dev', 'index.ts');
    const page = join('dashboard', 'spa', 'goals', 'GoalsView.tsx');
    const graph = new Map<string, string[]>([
      [page, [devIndex]],
      [devIndex, [`${FIDELITY_DIR}registry.ts`]],
      [ALLOWED_EDGE.from, [ALLOWED_EDGE.to]],
    ]);

    expect(reachesFidelity(graph)).toEqual([devIndex, page].sort());
  });
});
