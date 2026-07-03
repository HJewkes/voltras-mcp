/**
 * Panel container for the Phase 1 dashboard (VMCP-01.45).
 *
 * A titan-design `Card` (elevated surface, dark by default) with a `CardHeader`
 * / `CardTitle` section heading and a `CardContent` body — the titan-native
 * equivalent of the legacy `<section><h2>…</h2></section>` panel.
 */
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@titan-design/react-ui';

export interface PanelCardProps {
  title: string;
  children: ReactNode;
}

export function PanelCard({ title, children }: PanelCardProps): React.JSX.Element {
  return (
    <Card variant="elevated" elevation={2}>
      <CardHeader className="px-5 py-4">
        <CardTitle className="text-xs uppercase tracking-wider text-text-secondary">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-5 pt-0 pb-5">{children}</CardContent>
    </Card>
  );
}
