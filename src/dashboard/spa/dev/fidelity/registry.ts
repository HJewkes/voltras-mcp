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

/** A component the fidelity build saw but could not wrap, such as a `const` arrow component. */
export interface UninstrumentedComponent {
  readonly name: string;
  readonly source: string;
}

export interface FidelityRegistryHandle {
  readonly register: typeof register;
  readonly subscribe: typeof subscribe;
  readonly snapshot: typeof snapshot;
  readonly uninstrumented: typeof uninstrumented;
}

declare global {
  interface Window {
    __vmcpFidelity?: FidelityRegistryHandle;
  }
}

const entries = new Map<string, FidelityEntry>();
const listeners = new Set<() => void>();
const notInstrumented: UninstrumentedComponent[] = [];
let current: FidelitySnapshot = buildSnapshot();
let stale = false;

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

// The snapshot is rebuilt on the next read, not per change, so a mount burst of n entries costs O(n).
function publish(): void {
  stale = true;
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
  if (stale) {
    current = buildSnapshot();
    stale = false;
  }
  return current;
}

/** Called by the fidelity build from each module that defines components it could not wrap. */
export function noteUninstrumented(source: string, names: readonly string[]): void {
  for (const name of names) {
    const known = notInstrumented.some((item) => item.name === name && item.source === source);
    if (!known) notInstrumented.push({ name, source });
  }
}

export function uninstrumented(): readonly UninstrumentedComponent[] {
  return [...notInstrumented].sort(
    (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
  );
}

if (typeof window !== 'undefined') {
  window.__vmcpFidelity = { register, subscribe, snapshot, uninstrumented };
}
