/**
 * Dashboard color source of truth (Phase 4 — VMCP-01.48).
 *
 * titan-design's semantic theme tokens are the SINGLE source of every color in
 * this dashboard. They are defined in `@titan-design/react-ui/theme/global.css`
 * (imported once in `main.tsx`) and reach the UI three ways:
 *
 *   1. titan components (Card, Metric, MetricGroup, Table, VelocityStrip,
 *      BodyMap) emit Tailwind class strings that resolve to the tokens — the
 *      dashboard contributes no colors of its own inside them.
 *   2. `dashboard.css` app-chrome references the `--color-*` tokens via `var()`
 *      (header, status chip, battery chip, disconnect banner, grid).
 *   3. The handful of state-driven colors set from TSX (the connection status
 *      dot + label) map through {@link CONNECTION_TONE_TOKEN} below.
 *
 * RULE: never introduce an ad-hoc hex/rgb/hsl value anywhere under
 * `src/dashboard/spa/`. If a new semantic state needs a color, add its mapping
 * here against a titan `--color-*` token — do not hand-pick a shade. This module
 * is the one place to look before adding any color, so the four historical
 * velocity/RPE/status color schemes never re-diverge here.
 *
 * Velocity/RPE coloring is deliberately NOT modelled here: it lives entirely in
 * titan's `VelocityStrip` (`getVelocityZoneColor`), the canonical velocity scale
 * the dashboard renders directly (see CurrentSetPanel). Do not re-implement
 * velocity/RPE thresholds in the dashboard — collapsing that duplication is the
 * whole point of Phase 4.
 *
 * The one intentional token adjustment is `--color-text-tertiary`, re-valued one
 * notch lighter in `dashboard.css` purely to clear WCAG AA on the dark surfaces
 * (see the comment there). It is still a titan token, just locally scoped.
 */
import type { ConnectionTone } from './adapter';

/**
 * Connection tone → titan status token. `ConnectionTone` is the semantic state
 * (success / warning / error); each maps 1:1 onto titan's status palette so the
 * status dot, status label, battery-low chip (`dashboard.css`), and disconnect
 * banner all speak one color language. Values are `var()` references resolved at
 * render from the imported titan theme — no literal colors cross this boundary.
 */
export const CONNECTION_TONE_TOKEN: Record<ConnectionTone, string> = {
  success: 'var(--color-status-success)',
  warning: 'var(--color-status-warning)',
  error: 'var(--color-status-error)',
};
