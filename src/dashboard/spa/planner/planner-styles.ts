/**
 * Inline style objects shared by the planner + completion pages (VW-120).
 *
 * Plain `React.CSSProperties` on plain DOM elements — deliberately NOT titan
 * components. These two pages are operator/demo surfaces, not the wall display:
 * they are dense forms and tables, titan's react-native-web primitives ignore
 * Tailwind layout classNames (`flex-1`, `flex-row` silently no-op through RNW),
 * and nothing here is meant to become a design-system component. The live page
 * remains the styled surface.
 */
import type { CSSProperties } from 'react';

const INK = '#f3f4f6';
const MUTED = '#9ca3af';
const SURFACE = '#18181b';
const SURFACE_RAISED = '#27272a';
const BORDER = '#3f3f46';
const ACCENT = '#38bdf8';

export const color = { INK, MUTED, SURFACE, SURFACE_RAISED, BORDER, ACCENT } as const;

export const styles = {
  page: {
    minHeight: '100vh',
    background: '#101010',
    color: INK,
    font: '14px/1.5 Inter, system-ui, sans-serif',
    padding: 20,
    boxSizing: 'border-box',
  } satisfies CSSProperties,

  nav: {
    display: 'flex',
    gap: 16,
    alignItems: 'center',
    marginBottom: 20,
    paddingBottom: 12,
    borderBottom: `1px solid ${BORDER}`,
  } satisfies CSSProperties,

  navLink: { color: MUTED, textDecoration: 'none' } satisfies CSSProperties,
  navLinkActive: { color: ACCENT, textDecoration: 'none', fontWeight: 600 } satisfies CSSProperties,

  columns: { display: 'flex', gap: 20, alignItems: 'flex-start' } satisfies CSSProperties,
  column: { flex: '1 1 0', minWidth: 0 } satisfies CSSProperties,

  card: {
    background: SURFACE,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  } satisfies CSSProperties,

  cardActive: {
    background: SURFACE,
    border: `1px solid ${ACCENT}`,
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  } satisfies CSSProperties,

  row: {
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    padding: '8px 0',
    borderTop: `1px solid ${BORDER}`,
  } satisfies CSSProperties,

  heading: { margin: '0 0 12px', fontSize: 16, fontWeight: 600 } satisfies CSSProperties,
  subtle: { color: MUTED, fontSize: 12 } satisfies CSSProperties,
  error: { color: '#f87171', fontSize: 13, margin: '8px 0' } satisfies CSSProperties,

  input: {
    background: SURFACE_RAISED,
    color: INK,
    border: `1px solid ${BORDER}`,
    borderRadius: 4,
    padding: '6px 8px',
    font: 'inherit',
    minWidth: 0,
  } satisfies CSSProperties,

  button: {
    background: SURFACE_RAISED,
    color: INK,
    border: `1px solid ${BORDER}`,
    borderRadius: 4,
    padding: '6px 12px',
    font: 'inherit',
    cursor: 'pointer',
  } satisfies CSSProperties,

  buttonPrimary: {
    background: ACCENT,
    color: '#0b1620',
    border: `1px solid ${ACCENT}`,
    borderRadius: 4,
    padding: '6px 12px',
    font: 'inherit',
    fontWeight: 600,
    cursor: 'pointer',
  } satisfies CSSProperties,

  metric: { display: 'flex', gap: 24, flexWrap: 'wrap', margin: '8px 0' } satisfies CSSProperties,
  metricValue: { fontSize: 20, fontWeight: 600 } satisfies CSSProperties,
} as const;

/** Verdict tone → readout colour. `null` (no verdict) reads muted, never green. */
export function toneColor(tone: 'ok' | 'warn' | 'alarm' | null): string {
  if (tone === 'ok') return '#4ade80';
  if (tone === 'warn') return '#fbbf24';
  if (tone === 'alarm') return '#f87171';
  return MUTED;
}
