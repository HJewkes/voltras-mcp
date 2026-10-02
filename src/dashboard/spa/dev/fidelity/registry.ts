// Dev-only mount registry for the fidelity overlay (VW-431). Production source never imports it.

export type FidelityKind = 'titan' | 'spa' | 'placeholder';

export const FIDELITY_KINDS: readonly FidelityKind[] = ['titan', 'spa', 'placeholder'];

export interface FidelityEntry {
  readonly id: string;
  readonly kind: FidelityKind;
  readonly name: string;
  readonly source: string;
  readonly testID?: string;
}

export interface FidelityKindSummary {
  readonly instances: number;
  readonly names: readonly string[];
}

export interface FidelitySnapshot {
  readonly entries: readonly FidelityEntry[];
  readonly kinds: Readonly<Record<FidelityKind, FidelityKindSummary>>;
}

export interface FidelityRegistryHandle {
  readonly register: typeof register;
  readonly subscribe: typeof subscribe;
  readonly snapshot: typeof snapshot;
}

declare global {
  interface Window {
    __vmcpFidelity?: FidelityRegistryHandle;
  }
}

const entries = new Map<string, FidelityEntry>();
const listeners = new Set<() => void>();
let current: FidelitySnapshot = buildSnapshot();

function summarize(kind: FidelityKind, all: readonly FidelityEntry[]): FidelityKindSummary {
  const ofKind = all.filter((entry) => entry.kind === kind);
  const names = [...new Set(ofKind.map((entry) => entry.name))].sort();
  return { instances: ofKind.length, names };
}

function buildSnapshot(): FidelitySnapshot {
  const all = [...entries.values()];
  return {
    entries: all,
    kinds: {
      titan: summarize('titan', all),
      spa: summarize('spa', all),
      placeholder: summarize('placeholder', all),
    },
  };
}

function publish(): void {
  current = buildSnapshot();
  for (const listener of [...listeners]) listener();
}

/** Adds one mounted instance; the returned function removes exactly that instance. */
export function register(entry: FidelityEntry): () => void {
  entries.set(entry.id, entry);
  publish();
  return () => {
    if (entries.get(entry.id) !== entry) return;
    entries.delete(entry.id);
    publish();
  };
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The same object until the registry changes, so it is safe for useSyncExternalStore. */
export function snapshot(): FidelitySnapshot {
  return current;
}

if (typeof window !== 'undefined') {
  window.__vmcpFidelity = { register, subscribe, snapshot };
}
