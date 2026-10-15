// Dev-only provenance wrapper for the fidelity overlay (VW-431). Production source never imports it.

import {
  createElement,
  forwardRef,
  useId,
  useLayoutEffect,
  type ComponentType,
  type ForwardRefExoticComponent,
  type PropsWithoutRef,
  type RefAttributes,
} from 'react';

import { register, type FidelityEntry } from './registry.js';

export type ProvenanceMeta = Omit<FidelityEntry, 'id' | 'testID'>;

export const MARKER_START_ATTR = 'data-vmcp-fidelity-start';
export const MARKER_END_ATTR = 'data-vmcp-fidelity-end';

function readTestID(props: object): string | undefined {
  const value = (props as { testID?: unknown }).testID;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Renders `Component` unchanged between two hidden marker spans and registers the
 * instance while it is mounted. Every prop and the ref pass straight through.
 */
export function withProvenance<P extends object, R = unknown>(
  Component: ComponentType<P>,
  meta: ProvenanceMeta,
): ForwardRefExoticComponent<PropsWithoutRef<P> & RefAttributes<R>> {
  const Provenance = forwardRef<R, P>(function Provenance(props, ref) {
    const id = useId();
    const testID = readTestID(props);
    const { kind, name, source } = meta;

    useLayoutEffect(
      () => register({ id, kind, name, source, ...(testID === undefined ? {} : { testID }) }),
      [id, kind, name, source, testID],
    );

    return (
      <>
        <span hidden {...{ [MARKER_START_ATTR]: id }} />
        {createElement(Component, { ...props, ref } as P)}
        <span hidden {...{ [MARKER_END_ATTR]: id }} />
      </>
    );
  });
  Provenance.displayName = `Provenance(${meta.name})`;
  return Provenance;
}
