// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { type ReactElement } from 'react';
import { View, Text } from 'react-native';
import { Spinner, getSemanticColors } from '@titan-design/react-ui';

// Our own RN Text colour comes from the resolved dark-theme token, not a `text-*` className
// (className colours render black on the standalone wall SPA). See RestView's note.
const t = getSemanticColors('dark');

/*
 * ⚠ PORTING RULE (see LivePage.tsx): layout via `style`, colour via inline token `t[...]`
 * (NOT a `text-*` className — those do not resolve for our RN Text in the standalone SPA).
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
        style={{ color: t['text-secondary'], fontSize: 14, fontWeight: '600', letterSpacing: 0.5 }}
      >
        Connecting to the sidecar…
      </Text>
    </View>
  );
}
