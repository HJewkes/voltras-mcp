// Dev-only fidelity overlay (VW-431): outlines, merged labels, legend and promotion list.

import { useCallback, useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';

import {
  KIND_TITLES,
  PROMOTION_HEADING,
  STORAGE_KEY,
  groupOutlines,
  initialEnabled,
  isToggleShortcut,
  legendRows,
  overlayReport,
  promotionCandidates,
  type LegendRow,
  type MeasuredEntry,
  type OutlineGroup,
} from './overlay-model.js';
import {
  FIDELITY_KINDS,
  snapshot,
  subscribe,
  uninstrumented,
  type FidelityEntry,
  type FidelityKind,
  type FidelitySnapshot,
} from './registry.js';
import { MARKER_END_ATTR, MARKER_START_ATTR } from './with-provenance.js';

export const FIDELITY_PILL_LABEL = 'FIDELITY BUILD';
export const REMEASURE_INTERVAL_MS = 250;

const TOP = 2147483647;
const KIND_COLORS: Readonly<Record<FidelityKind, string>> = {
  titan: 'var(--color-brand-secondary, #307B9B)',
  spa: 'var(--color-brand-primary, #FF7900)',
  placeholder: 'var(--color-status-warning, #F9B415)',
};
const PANEL_TEXT = 'var(--color-text-primary, #F5F5F5)';
const PANEL_MUTED = 'var(--color-text-secondary, #B5B5B5)';
const PANEL_BACKGROUND = 'var(--color-surface-overlay, rgba(16, 16, 16, 0.94))';
const PANEL_BORDER = 'var(--color-hairline-strong, rgba(255, 255, 255, 0.24))';

/** Coalesces a burst of registry changes (one per mounted component) into one notification. */
function subscribeBatched(listener: () => void): () => void {
  let queued = false;
  let active = true;
  const unsubscribe = subscribe(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (active) listener();
    });
  });
  return () => {
    active = false;
    unsubscribe();
  };
}

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(enabled: boolean): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Storage can be unavailable in a locked-down browser; the toggle still works for this page.
  }
}

/** Off by default; `?fidelity=1`, the pill or Alt+Shift+F turns it on, remembered per tab. */
function useFidelityToggle(): [boolean, () => void] {
  const [enabled, setEnabled] = useState(() =>
    initialEnabled(window.location.search, readStored()),
  );
  useEffect(() => writeStored(enabled), [enabled]);
  const toggle = useCallback(() => setEnabled((on) => !on), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isToggleShortcut(event)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);
  return [enabled, toggle];
}

/** Markers by entry id, read with one query per side so no selector is ever built from an id. */
function markersById(attribute: string): Map<string, Element> {
  const found = new Map<string, Element>();
  for (const marker of document.querySelectorAll(`[${attribute}]`)) {
    found.set(marker.getAttribute(attribute) ?? '', marker);
  }
  return found;
}

/** Each entry's rect is the DOM range between its markers, in document order (outermost first). */
export function measureEntries(entries: readonly FidelityEntry[]): MeasuredEntry[] {
  const starts = markersById(MARKER_START_ATTR);
  const ends = markersById(MARKER_END_ATTR);
  const order = new Map([...starts.keys()].map((id, index) => [id, index]));
  const measured: { item: MeasuredEntry; index: number }[] = [];
  for (const entry of entries) {
    const start = starts.get(entry.id);
    const end = ends.get(entry.id);
    if (start === undefined || end === undefined) continue;
    const range = document.createRange();
    range.setStartAfter(start);
    range.setEndBefore(end);
    const { left, top, width, height } = range.getBoundingClientRect();
    const item = { entry, rect: { x: left, y: top, width, height } };
    measured.push({ item, index: order.get(entry.id) ?? 0 });
  }
  return measured.sort((a, b) => a.index - b.index).map(({ item }) => item);
}

const NO_GROUPS: OutlineGroup[] = [];

/** Re-measures on registry change, scroll, resize and a 250 ms tick, and only while on. */
function useOutlineGroups(enabled: boolean, current: FidelitySnapshot): OutlineGroup[] {
  const [groups, setGroups] = useState<OutlineGroup[]>(NO_GROUPS);
  useEffect(() => {
    if (!enabled) return undefined;
    const remeasure = (): void => setGroups(groupOutlines(measureEntries(snapshot().entries)));
    remeasure();
    window.addEventListener('scroll', remeasure, { capture: true, passive: true });
    window.addEventListener('resize', remeasure);
    const timer = window.setInterval(remeasure, REMEASURE_INTERVAL_MS);
    return () => {
      window.removeEventListener('scroll', remeasure, { capture: true });
      window.removeEventListener('resize', remeasure);
      window.clearInterval(timer);
    };
  }, [enabled, current]);
  return enabled ? groups : NO_GROUPS;
}

function outlineStyle(group: OutlineGroup): CSSProperties {
  const { x, y, width, height } = group.rect;
  return {
    position: 'fixed',
    left: x,
    top: y,
    width,
    height,
    boxSizing: 'border-box',
    border: `1px ${group.dashed ? 'dashed' : 'solid'} ${KIND_COLORS[group.kind]}`,
    pointerEvents: 'none',
  };
}

function tagStyle(group: OutlineGroup): CSSProperties {
  return {
    position: 'absolute',
    left: -1,
    ...(group.rect.y >= 14 ? { bottom: '100%' } : { top: 0 }),
    padding: '0 4px',
    background: KIND_COLORS[group.kind],
    color: '#101010',
    font: '600 10px/14px system-ui, sans-serif',
    whiteSpace: 'nowrap',
  };
}

function Outlines({ groups }: { groups: readonly OutlineGroup[] }): React.JSX.Element {
  return (
    <div data-testid="fidelity-outlines" style={{ pointerEvents: 'none' }}>
      {groups.map((group) => (
        <div key={group.key} data-fidelity-kind={group.kind} style={outlineStyle(group)}>
          {group.tagged ? <span style={tagStyle(group)}>{group.label}</span> : null}
        </div>
      ))}
    </div>
  );
}

function NameList({ row }: { row: LegendRow }): React.JSX.Element | null {
  const parts = [...row.names];
  if (row.iconNames.length > 0) parts.push(`${row.iconNames.length} icons`);
  if (parts.length === 0) return null;
  return (
    <div title={row.iconNames.join(', ')} style={{ color: PANEL_MUTED, marginLeft: 16 }}>
      {parts.join(', ')}
    </div>
  );
}

function LegendKindRow({ row }: { row: LegendRow }): React.JSX.Element {
  const swatch: CSSProperties = {
    display: 'inline-block',
    width: 10,
    height: 10,
    marginRight: 6,
    border: `2px ${row.kind === 'placeholder' ? 'dashed' : 'solid'} ${KIND_COLORS[row.kind]}`,
  };
  return (
    <div data-testid={`fidelity-legend-${row.kind}`} style={{ marginBottom: 6 }}>
      <span style={swatch} />
      <strong>{row.title}</strong>: <span data-testid="instances">{row.instances}</span> instances,{' '}
      {row.distinctNames} names
      <NameList row={row} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 10 }}>
      <h3 style={{ margin: '0 0 4px', font: '600 12px/1.4 system-ui, sans-serif' }}>{title}</h3>
      {children}
    </section>
  );
}

function SourceList({ items }: { items: readonly { name: string; source: string }[] }) {
  if (items.length === 0) return <div style={{ color: PANEL_MUTED }}>none</div>;
  return (
    <ul style={{ margin: 0, paddingLeft: 16 }}>
      {items.map((item) => (
        <li key={`${item.source}#${item.name}`}>
          {item.name} <span style={{ color: PANEL_MUTED }}>{item.source}</span>
        </li>
      ))}
    </ul>
  );
}

const BUTTON_STYLE: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 4,
  border: `1px solid ${PANEL_BORDER}`,
  background: 'transparent',
  color: PANEL_TEXT,
  font: 'inherit',
  cursor: 'pointer',
};

function CopyJsonButton({ current }: { current: FidelitySnapshot }): React.JSX.Element {
  const [status, setStatus] = useState('');
  const copy = (): void => {
    const json = JSON.stringify(overlayReport(current, uninstrumented()), null, 2);
    navigator.clipboard.writeText(json).then(
      () => setStatus('Copied'),
      () => setStatus('Copy failed'),
    );
  };
  return (
    <div style={{ marginTop: 10 }}>
      <button type="button" onClick={copy} style={BUTTON_STYLE}>
        Copy as JSON
      </button>{' '}
      <span style={{ color: PANEL_MUTED }}>{status}</span>
    </div>
  );
}

const LEGEND_STYLE: CSSProperties = {
  position: 'fixed',
  right: 12,
  bottom: 44,
  width: 360,
  maxHeight: '70vh',
  overflowY: 'auto',
  padding: 12,
  borderRadius: 8,
  background: PANEL_BACKGROUND,
  border: `1px solid ${PANEL_BORDER}`,
  color: PANEL_TEXT,
  font: '12px/1.4 system-ui, sans-serif',
  pointerEvents: 'auto',
};

export function FidelityLegend({ current }: { current: FidelitySnapshot }): React.JSX.Element {
  return (
    <aside data-testid="fidelity-legend" aria-label="Fidelity legend" style={LEGEND_STYLE}>
      {legendRows(current).map((row) => (
        <LegendKindRow key={row.kind} row={row} />
      ))}
      <Section title={PROMOTION_HEADING}>
        <SourceList items={promotionCandidates(current)} />
      </Section>
      <Section title="not instrumented">
        <SourceList items={uninstrumented()} />
      </Section>
      <CopyJsonButton current={current} />
    </aside>
  );
}

const PILL_STYLE: CSSProperties = {
  position: 'fixed',
  right: 12,
  bottom: 12,
  padding: '4px 10px',
  borderRadius: 999,
  background: 'rgba(16, 16, 16, 0.85)',
  border: '1px solid currentColor',
  color: 'rgb(245, 197, 66)',
  font: '600 12px/1.4 system-ui, sans-serif',
  cursor: 'pointer',
  pointerEvents: 'auto',
};

/** Always visible in a fidelity bundle, so a stray one on the wall is obvious on sight. */
export function FidelityPill(props: {
  enabled: boolean;
  current: FidelitySnapshot;
  onToggle: () => void;
}): React.JSX.Element {
  const counts = FIDELITY_KINDS.map(
    (kind) => `${KIND_TITLES[kind]} ${props.current.kinds[kind].instances}`,
  ).join(' · ');
  return (
    <button
      type="button"
      data-testid="fidelity-pill"
      aria-pressed={props.enabled}
      title="Toggle the fidelity overlay (Alt+Shift+F)"
      onClick={props.onToggle}
      style={PILL_STYLE}
    >
      {FIDELITY_PILL_LABEL} · {props.enabled ? 'overlay on' : 'overlay off'} · {counts}
    </button>
  );
}

export function FidelityOverlay(): React.JSX.Element {
  const [enabled, toggle] = useFidelityToggle();
  const current = useSyncExternalStore(subscribeBatched, snapshot);
  const groups = useOutlineGroups(enabled, current);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: TOP, pointerEvents: 'none' }}>
      {enabled ? <Outlines groups={groups} /> : null}
      {enabled ? <FidelityLegend current={current} /> : null}
      <FidelityPill enabled={enabled} current={current} onToggle={toggle} />
    </div>
  );
}
