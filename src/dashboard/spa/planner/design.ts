/**
 * Layout constants for the operator routes (VW-121 design pass).
 *
 * ── Why these live here and not in titan ──────────────────────────────────
 *
 * titan ships colour, elevation, and type tokens but **no spacing scale** —
 * `theme/tokens/primitives.ts` has no `spacing` export, and its components
 * space themselves with Tailwind classes (`px-6`, `gap-2`) that don't survive
 * react-native-web when a consumer writes layout through `style`, which is the
 * rule these pages follow. So the pages were spacing themselves with whatever
 * number was typed at the time: 4, 6, 8, 10, 12, 16, 20 — a 7-step "scale" with
 * two values (6, 10) that exist once each and align to nothing.
 *
 * This is the local 4px scale until titan grows a real one; the moment it does,
 * this file becomes a re-export and every call site is already indirected.
 *
 * Colour is deliberately ABSENT here. There are no raw hexes anywhere on these
 * two pages and there must not be — colour comes from `<Surface level>`,
 * `useOnSurfaceColor`, and semantic `var(--color-*)` tokens.
 */

/** The 4px spacing scale. Every gap/padding/margin on these pages is one of these. */
export const SPACE = {
  /** 4 — inside a chip cluster. */
  xxs: 4,
  /** 8 — between adjacent controls in a row. */
  xs: 8,
  /** 12 — between a row's stacked lines; a list row's vertical padding. */
  sm: 12,
  /** 16 — between panels, and a panel's own gutter. */
  md: 16,
  /** 20 — the page gutter. */
  lg: 20,
  /** 24 — between major page sections. */
  xl: 24,
} as const;

/** Corner radii. `card` matches titan's `rounded-2xl` on a Surface. */
export const RADIUS = {
  card: 16,
} as const;

/**
 * Control heights. titan's `Button size="sm"` is `min-h-[32px]` and its
 * `Input size="sm"` is `h-8` (32px) — but an `outline` button adds a 2px border
 * per side and a bare-string child skips the button's own `text-sm` class, so
 * "Add" measured **40px tall at 16px type** next to a 32px, 14px input.
 * Pinning the height makes a control row actually line up; wrapping labels in
 * `Typography variant="button"` is what fixes the type size.
 */
export const CONTROL_HEIGHT = 32;

/** Width of one numeric target box. One width for all four — they are peers. */
export const TARGET_FIELD_WIDTH = 56;

/**
 * A quiet, repeated row action (the catalog's 30 "Add"s).
 *
 * `outline` gave each row a 2px BRAND-ORANGE border, so thirty secondary
 * actions carried the visual weight of a primary one and the page had no
 * loudest element left. Plain `ghost` over-corrected — with no border at rest
 * "Add" read as body text. A neutral hairline is the middle: unmistakably a
 * control, competing with nothing. The colour is a token, not a hex.
 */
export const QUIET_ACTION_BORDER = {
  borderWidth: 1,
  borderColor: 'var(--color-hairline-strong)',
} as const;
