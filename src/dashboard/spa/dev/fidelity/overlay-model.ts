// Pure model behind the fidelity overlay (VW-431): rect grouping, label merging and legend rows.

import {
  FIDELITY_KINDS,
  type FidelityEntry,
  type FidelityKind,
  type FidelitySnapshot,
  type UninstrumentedComponent,
} from './registry.js';

export const STORAGE_KEY = 'vmcp-fidelity-overlay';
export const PROMOTION_HEADING = 'titan promotion candidates';

export const KIND_TITLES: Readonly<Record<FidelityKind, string>> = {
  titan: 'titan',
  spa: 'SPA-local',
  placeholder: 'placeholder',
};

export interface OverlayRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MeasuredEntry {
  readonly entry: FidelityEntry;
  readonly rect: OverlayRect;
}

export interface OutlineGroup {
  readonly key: string;
  readonly rect: OverlayRect;
  /** Outermost first, the order their start markers appear in the document. */
  readonly entries: readonly FidelityEntry[];
  readonly label: string;
  /** The innermost entry's kind: the component closest to the box that is drawn. */
  readonly kind: FidelityKind;
  readonly dashed: boolean;
  /** False when every entry is an icon, so a page of icons does not bury the real labels. */
  readonly tagged: boolean;
}

export interface LegendRow {
  readonly kind: FidelityKind;
  readonly title: string;
  readonly instances: number;
  readonly distinctNames: number;
  readonly names: readonly string[];
  readonly iconNames: readonly string[];
}

export interface PromotionCandidate {
  readonly name: string;
  readonly source: string;
  readonly instances: number;
}

export interface OverlayReport {
  readonly kinds: Readonly<Record<FidelityKind, { instances: number; names: readonly string[] }>>;
  readonly promotionCandidates: readonly PromotionCandidate[];
  readonly uninstrumented: readonly UninstrumentedComponent[];
}

/** Titan icons arrive as props on almost every card, so the legend collapses them into one line. */
export function isIconLike(entry: Pick<FidelityEntry, 'kind' | 'name'>): boolean {
  return entry.kind === 'titan' && /Icon$/.test(entry.name);
}

function roundedRect(rect: OverlayRect): OverlayRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function rectKey(rect: OverlayRect): string {
  return `${rect.x},${rect.y},${rect.width},${rect.height}`;
}

function toGroup(key: string, rect: OverlayRect, entries: readonly FidelityEntry[]): OutlineGroup {
  const innermost = entries[entries.length - 1]!;
  return {
    key,
    rect,
    entries,
    label: entries.map((entry) => entry.name).join(' > '),
    kind: innermost.kind,
    dashed: entries.some((entry) => entry.kind === 'placeholder'),
    tagged: entries.some((entry) => !isIconLike(entry)),
  };
}

/** One outline per distinct box; entries sharing a rect merge into one stacked label. */
export function groupOutlines(measured: readonly MeasuredEntry[]): OutlineGroup[] {
  const byRect = new Map<string, { rect: OverlayRect; entries: FidelityEntry[] }>();
  for (const { entry, rect } of measured) {
    const rounded = roundedRect(rect);
    if (rounded.width <= 0 || rounded.height <= 0) continue;
    const key = rectKey(rounded);
    const group = byRect.get(key) ?? { rect: rounded, entries: [] };
    group.entries.push(entry);
    byRect.set(key, group);
  }
  return [...byRect].map(([key, group]) => toGroup(key, group.rect, group.entries));
}

function legendRow(kind: FidelityKind, snapshot: FidelitySnapshot): LegendRow {
  const { instances, names } = snapshot.kinds[kind];
  const iconNames = names.filter((name) => isIconLike({ kind, name }));
  return {
    kind,
    title: KIND_TITLES[kind],
    instances,
    distinctNames: names.length,
    names: names.filter((name) => !iconNames.includes(name)),
    iconNames,
  };
}

/** One row per kind, placeholder included at zero until something declares it. */
export function legendRows(snapshot: FidelitySnapshot): LegendRow[] {
  return FIDELITY_KINDS.map((kind) => legendRow(kind, snapshot));
}

export function promotionCandidates(snapshot: FidelitySnapshot): PromotionCandidate[] {
  const byKey = new Map<string, PromotionCandidate>();
  for (const entry of snapshot.entries) {
    if (entry.kind !== 'spa') continue;
    const key = `${entry.source}#${entry.name}`;
    const instances = (byKey.get(key)?.instances ?? 0) + 1;
    byKey.set(key, { name: entry.name, source: entry.source, instances });
  }
  return [...byKey.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
  );
}

export function overlayReport(
  snapshot: FidelitySnapshot,
  uninstrumented: readonly UninstrumentedComponent[],
): OverlayReport {
  return {
    kinds: snapshot.kinds,
    promotionCandidates: promotionCandidates(snapshot),
    uninstrumented,
  };
}

/** `?fidelity=1` or `?fidelity=0` wins; otherwise the tab's stored choice; otherwise off. */
export function initialEnabled(search: string, stored: string | null): boolean {
  const fromUrl = new URLSearchParams(search).get('fidelity');
  if (fromUrl === '1' || fromUrl === '0') return fromUrl === '1';
  return stored === '1';
}

/** Alt+Shift+F, matched on the physical key because macOS turns Alt+Shift+F into another character. */
export function isToggleShortcut(event: {
  altKey: boolean;
  shiftKey: boolean;
  code: string;
}): boolean {
  return event.altKey && event.shiftKey && event.code === 'KeyF';
}
