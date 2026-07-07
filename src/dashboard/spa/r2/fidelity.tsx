/**
 * Fidelity legend (the operator's core ask for the R2 harness).
 *
 * Every rendered element is wrapped in `<F kind name>` declaring its
 * provenance; a dev toggle (default ON) outlines each wrapper:
 *
 *   - `real` — REAL titan component, teal outline + component-name tag
 *   - `new`  — NET-NEW shell component (Phase-2 seed), orange outline + name
 *   - `mock` — placeholder/stub content or mock data, dashed gray + "mock" tag
 *
 * Counts in the legend bar come from a mount registry so the inventory is
 * live, not hand-maintained.
 */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type FidelityKind = 'real' | 'new' | 'mock';

interface Registry {
  register: (kind: FidelityKind, name: string) => () => void;
}

interface FidelityCtx extends Registry {
  on: boolean;
  toggle: () => void;
  counts: Record<FidelityKind, number>;
  names: Record<FidelityKind, string[]>;
}

const Ctx = createContext<FidelityCtx | null>(null);

export function useFidelity(): FidelityCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useFidelity outside FidelityProvider');
  return ctx;
}

export function FidelityProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [on, setOn] = useState(true); // default ON at first load
  const [version, setVersion] = useState(0);
  const registryRef = useRef(new Map<string, { kind: FidelityKind; name: string; n: number }>());

  const register = useMemo(
    () =>
      (kind: FidelityKind, name: string): (() => void) => {
        const key = `${kind}:${name}`;
        const reg = registryRef.current;
        const entry = reg.get(key) ?? { kind, name, n: 0 };
        entry.n += 1;
        reg.set(key, entry);
        setVersion((v) => v + 1);
        return () => {
          const e = reg.get(key);
          if (e) {
            e.n -= 1;
            if (e.n <= 0) reg.delete(key);
          }
          setVersion((v) => v + 1);
        };
      },
    [],
  );

  const { counts, names } = useMemo(() => {
    void version;
    const counts: Record<FidelityKind, number> = { real: 0, new: 0, mock: 0 };
    const names: Record<FidelityKind, string[]> = { real: [], new: [], mock: [] };
    for (const e of registryRef.current.values()) {
      counts[e.kind] += 1;
      if (!names[e.kind].includes(e.name)) names[e.kind].push(e.name);
    }
    return { counts, names };
  }, [version]);

  const value = useMemo<FidelityCtx>(
    () => ({ on, toggle: () => setOn((v) => !v), counts, names, register }),
    [on, counts, names, register],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export interface FProps {
  kind: FidelityKind;
  /** Component / element name shown in the tag (e.g. "titan:SetRow"). */
  name: string;
  /** Extra annotation appended to the tag (e.g. "displayOnly fallback"). */
  note?: string;
  block?: boolean;
  children: React.ReactNode;
}

/** Provenance wrapper — outlines + tags its subtree when the legend is on. */
export function F({ kind, name, note, block = true, children }: FProps): React.JSX.Element {
  const { on, register } = useFidelity();
  useEffect(() => register(kind, name), [kind, name, register]);
  const cls = on ? `f-wrap f-${kind}` : 'f-wrap';
  return (
    <div className={cls} style={{ display: block ? 'block' : 'inline-block' }}>
      {on && (
        <span className={`f-tag f-tag-${kind}`}>
          {kind === 'mock' ? `mock · ${name}` : name}
          {note ? ` — ${note}` : ''}
        </span>
      )}
      {children}
    </div>
  );
}

/** Inline amber annotation for shipped-reality gaps ("pending WA-02.04"). */
export function PendingNote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="pending-note">⚠ {children}</span>;
}

export function LegendBar(): React.JSX.Element {
  const { on, toggle, counts } = useFidelity();
  return (
    <div className="legend-bar">
      <button type="button" className="legend-toggle" onClick={toggle}>
        {on ? 'fidelity legend: ON' : 'fidelity legend: off'}
      </button>
      {on && (
        <span className="legend-items">
          <span className="legend-chip legend-real">real titan · {counts.real}</span>
          <span className="legend-chip legend-new">net-new · {counts.new}</span>
          <span className="legend-chip legend-mock">mock/stub · {counts.mock}</span>
        </span>
      )}
    </div>
  );
}
