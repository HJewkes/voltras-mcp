/**
 * Panel container for the Phase 1 dashboard (VMCP-01.45).
 *
 * A titan-design `Card` (elevated surface, dark by default) with a `CardHeader`
 * / `CardTitle` section heading and a `CardContent` body — the titan-native
 * equivalent of the legacy `<section><h2>…</h2></section>` panel.
 *
 * Accessibility (Phase 5 — VMCP-01.49): every panel is wrapped in a native
 * `<section>` exposed as an ARIA `region` landmark named after its title
 * (`CardTitle` renders the same text visually, so this is a same-text
 * `aria-label`, not a duplicate source of truth). That lets screen-reader
 * users jump directly between "Current set", "Rest timer", "Sets this
 * session", "Session progress", and "Muscle heatmap" via landmark navigation
 * instead of reading the whole grid linearly. A plain intrinsic element is
 * used (rather than passing `role`/`aria-label` into `<Card>`) because
 * `CardProps` — sourced from titan's own `react-native` `ViewProps` — doesn't
 * surface those ARIA props to the type checker; the native wrapper carries no
 * layout of its own, so it's visually inert inside `.app-grid`.
 */
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@titan-design/react-ui';

export interface PanelCardProps {
  title: string;
  children: ReactNode;
}

export function PanelCard({ title, children }: PanelCardProps): React.JSX.Element {
  return (
    <section role="region" aria-label={title}>
      <Card variant="elevated" elevation={2}>
        <CardHeader className="px-5 py-4">
          <CardTitle className="text-xs uppercase tracking-wider text-text-secondary">
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 pt-0 pb-5">{children}</CardContent>
      </Card>
    </section>
  );
}
