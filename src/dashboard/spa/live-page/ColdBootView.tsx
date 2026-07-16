// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { type ReactElement } from 'react';
import { View, Text } from 'react-native';
import { Spinner } from '@titan-design/react-ui';

/*
 * ⚠ PORTING RULE (see LivePage.tsx): layout via `style`, colour via className.
 *
 * The cold-boot stage (VW-68). `mapStoreToDashboardModel` returns null until the FIRST
 * snapshot lands (poll or SSE) — before that there is no session, no device, nothing to
 * project. Rather than mount nothing (a blank viewport), show an honest "connecting" state
 * while the first snapshot is in flight. Distinct from the connected-idle EmptyLiveView:
 * here we do not yet know whether a device or session exists.
 */
export function ColdBootView(): ReactElement {
  return (
    <View
      className="bg-surface-base"
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 }}
    >
      <Spinner size="lg" />
      <Text
        className="text-text-secondary"
        style={{ fontSize: 14, fontWeight: '600', letterSpacing: 0.5 }}
      >
        Connecting to the sidecar…
      </Text>
    </View>
  );
}
