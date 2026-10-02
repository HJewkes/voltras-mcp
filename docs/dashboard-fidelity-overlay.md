# Dashboard fidelity overlay (VW-431)

The fidelity overlay is a dev-only layer for the dashboard SPA. It shows which parts of a
page come from `@titan-design/react-ui`, which are SPA-local components (the titan
promotion candidates), and which are declared placeholders. This page documents the mount
registry the overlay reads. The build mode and the overlay itself land in later slices.

All of it lives in `src/dashboard/spa/dev/fidelity/`. Production source never imports that
folder. `src/dashboard/__tests__/spa-fidelity-registry.test.ts` fails if any file under
`src/` outside the folder and its own tests mentions `dev/fidelity`.

## The registry

`dev/fidelity/registry.ts` is a plain module store with no React context. It exports three
functions:

| Function              | Returns                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `register(entry)`     | A function that removes exactly that entry. Call it on unmount.          |
| `subscribe(listener)` | A function that removes the listener. The listener runs on every change. |
| `snapshot()`          | The current snapshot, the same object until the registry next changes.   |

`snapshot()` is stable between changes, so `useSyncExternalStore(subscribe, snapshot)`
works directly.

### Entry shape

```ts
interface FidelityEntry {
  id: string; // one mounted instance; matches its marker spans
  kind: 'titan' | 'spa' | 'placeholder';
  name: string; // component name, for example 'Surface' or 'PanelCard'
  source: string; // import specifier for titan, SPA file path otherwise
  testID?: string; // the instance's testID prop, when it has a string one
}
```

### Snapshot shape

```ts
interface FidelitySnapshot {
  entries: FidelityEntry[]; // every mounted instance
  kinds: Record<'titan' | 'spa' | 'placeholder', { instances: number; names: string[] }>;
}
```

`instances` counts mounted entries of that kind. `names` lists each distinct name once,
sorted.

## The window handle

Importing the registry sets `window.__vmcpFidelity` to `{ register, subscribe, snapshot }`.
Playwright and other dev tools read it from the page, for example:

```ts
const counts = await page.evaluate(() => window.__vmcpFidelity?.snapshot().kinds);
```

The handle exists only in a bundle that imports the registry, which a production build
never does.

## The provenance wrapper

`withProvenance(Component, { kind, name, source })` in `dev/fidelity/with-provenance.tsx`
returns a `forwardRef` component. It:

- forwards every prop and the ref to `Component`, so a titan parent that clones its
  children with injected props and refs still reaches the real component;
- renders `Component`'s output between two `hidden` spans carrying the entry id in
  `data-vmcp-fidelity-start` and `data-vmcp-fidelity-end`. Hidden elements take no layout
  box, so the wrapper adds no flex item, gap or size;
- registers the instance in a layout effect and unregisters it on unmount.

The overlay measures each entry as the DOM range between its two markers. A component that
draws no box of its own still gets a rect: the union of what it renders.
