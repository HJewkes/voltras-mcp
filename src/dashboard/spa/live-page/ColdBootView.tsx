// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { type ReactElement } from 'react';
import { Text } from 'react-native';
import { Spinner, Surface, useOnSurfaceColor } from '@titan-design/react-ui';

/*
 * ⚠ PORTING RULE (see LivePage.tsx): layout via `style`, colour via the on-surface context.
 * The `<Surface>` root owns the charcoal plane AND seeds the on-surface colour context, so our
 * RN Text reads its colour through `useOnSurfaceColor` (literal hex) instead of a `text-*`
 * className, which does not resolve for raw RN Text on the standalone wall SPA (renders black).
 *
 * The cold-boot stage (VW-68). `mapStoreToDashboardModel` returns null until the FIRST
 * snapshot lands (poll or SSE) — before that there is no session, no device, nothing to
 * project. Rather than mount nothing (a blank viewport), show an honest "connecting" state
 * while the first snapshot is in flight. Distinct from the connected-idle EmptyLiveView:
 * here we do not yet know whether a device or session exists.
 */
export function ColdBootView(): ReactElement {
  const textColor = useOnSurfaceColor('secondary');
  return (
    <Surface
      level="base"
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}
    >
      <Spinner size="lg" />
      <Text style={{ color: textColor, fontSize: 14, fontWeight: '600', letterSpacing: 0.5 }}>
        Connecting to the sidecar…
      </Text>
    </Surface>
  );
}
