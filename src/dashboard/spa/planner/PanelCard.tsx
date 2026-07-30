/**
 * The operator routes' card plane (VW-121 design pass).
 *
 * ── Why not titan's `Card` ────────────────────────────────────────────────
 *
 * Measured, not guessed. `Card variant="elevated"` rendered at **#393634
 * (L* 22.8)** on these pages, against a page plane of #1C1916 (L* 9) — a
 * ΔL* of ~14, and BRIGHTER than `surface-overlay` (#373635, L* 22.7), the
 * lightest step on titan's entire grey ramp and the one reserved for
 * hero/popover. The cards were literally off the top of the ramp, which is
 * exactly what "too bright for the surface system" describes.
 *
 * The cause is structural, not a bad prop value: `Card` doesn't read the ramp
 * at all. It computes `getElevationSurface(getBaseSurfaceColor(theme), n)`, and
 * `getBaseSurfaceColor('dark')` is already `surface-elevated` (#2C2A28) — so
 * even `elevation={1}` starts a step ABOVE where a card should land and
 * lightens from there. There is no `Card` prop that reaches `surface-raised`.
 *
 * `Surface` is the primitive that IS ramp-aware, so the card plane comes from
 * `level="raised"` (#31302F, L* 19.9) — the token whose own definition in
 * `semantic.ts` is annotated "raised surface — cards". One clean step up from
 * the `base` page plane (#252321, L* 13.9): ΔL* 6, perceptible and calm,
 * instead of a bright slab floating on a dark shell.
 *
 * Two things fall out of using `Surface` that `Card` could not give us:
 *   * it publishes the on-surface colour CONTEXT, so descendants resolve text
 *     against the card they are actually on (`Card` renders no SurfaceContext,
 *     so text inside one resolved against the PAGE's level);
 *   * inputs (`bg-surface-input` → #2C2A28) now sit one step BELOW the card
 *     rather than above it, so a field reads as recessed, which is what the
 *     elevation system says a field is.
 *
 * titan's `CardHeader` / `CardTitle` / `CardContent` are pure padding + text
 * with no background of their own, so they compose over `Surface` unchanged —
 * this keeps the card's structure and only takes over the plane.
 */
import React from 'react';
import {
  CardContent,
  CardHeader,
  CardTitle,
  Surface,
  Typography,
  useOnSurfaceColor,
} from '@titan-design/react-ui';

import { RADIUS, SPACE } from './design';

export function PanelCard(props: {
  /** Card heading. Omit for a card that is all content. */
  title?: string;
  /** Trailing header content (a badge, a status pill), right-aligned on the title row. */
  titleRight?: React.ReactNode;
  /** Status border, e.g. the error note's. A token string, never a literal hex. */
  borderColor?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Surface
      level="raised"
      style={{
        borderRadius: RADIUS.card,
        overflow: 'hidden',
        ...(props.borderColor === undefined
          ? {}
          : { borderWidth: 1, borderColor: props.borderColor }),
      }}
    >
      {props.title !== undefined && (
        // titan's CardHeader is `px-6 py-6` — 24px of chrome above every panel,
        // which on a page of six stacked cards is most of a screen of padding.
        // The header keeps the horizontal gutter and loses the vertical excess.
        <CardHeader className="px-5 pt-4 pb-1">
          <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.sm }}>
            <div style={{ flex: '1 1 0', minWidth: 0 }}>
              <CardTitle>{props.title}</CardTitle>
            </div>
            {props.titleRight}
          </div>
        </CardHeader>
      )}
      <CardContent className={props.title === undefined ? 'px-5 py-4' : 'px-5 pb-4 pt-2'}>
        {props.children}
      </CardContent>
    </Surface>
  );
}

/** Vertical rhythm between stacked panels. Exported so both pages agree. */
export const PANEL_GAP = SPACE.md;

/**
 * A button's label at the type scale, with its colour stated explicitly.
 *
 * Two titan gaps meet here, both measured:
 *
 *   * `Button` applies `textSizeStyles[size]` only to its own `loadingText`; a
 *     bare string child is rendered raw, so it inherited the document's 16px
 *     and pushed a `size="sm"` button to **40px tall next to a 32px input**.
 *     Wrapping the label in `Typography variant="button"` is what fixes that.
 *   * `Typography color="inherit"` — the obvious way to keep the button
 *     variant's own colour — resolved to **rgb(0,0,0)** on all 45 labels. It
 *     emits a `text-inherit` className, and a `text-*` class with nothing to
 *     inherit from bottoms out at black. This is the exact class of bug
 *     `Surface`/`useOnSurfaceColor` exists to retire, so the colour is named.
 *
 * `tone` is what the label sits ON, not what colour it is: a `ghost`/`outline`
 * button sits on the card, an `on-solid` label sits on a filled brand/error fill.
 */
export function ButtonLabel(props: {
  tone?: 'on-surface' | 'on-solid';
  children: React.ReactNode;
}): React.JSX.Element {
  const onSurface = useOnSurfaceColor('primary');
  const color = props.tone === 'on-solid' ? 'var(--color-text-inverse)' : onSurface;
  return (
    <Typography variant="button" style={{ color }}>
      {props.children}
    </Typography>
  );
}
