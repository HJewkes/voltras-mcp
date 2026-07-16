// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { type ReactElement } from 'react';
import { View } from 'react-native';
import {
  EmptyState,
  Metric,
  MetricGroup,
  DumbbellIcon,
  BluetoothIcon,
} from '@titan-design/react-ui';
import { type DashboardModel } from './model';

/*
 * ⚠ PORTING RULE (see LivePage.tsx): layout via `style`, colour via className.
 *
 * The honest IDLE stage. `RestView` renders a blank padded box when nothing is streaming,
 * nothing is logged, and no rest clock is running (no-session, a session whose first set has
 * not begun, or a disconnected device). That barren view is what the operator hit. This
 * replaces it with a designed empty state — a "waiting for a set" hero plus only the device
 * facts the store can honestly source (loaded weight when the cascade reported one; hidden
 * under the mock adapter, and never a fabricated 0).
 *
 * READ-ONLY WALL: sets start on the machine / via MCP, never from this mirror, so there is no
 * button — the affordance is an instruction line. Battery + the connection glyph live in the
 * shell TopBar (VW-67); this only shifts its COPY on a known disconnect (VW-68), so a wall
 * that lost its cable says "connect a Voltra" rather than "waiting for a set".
 */

/** The designed idle stage — replaces the blank `RestView` when `stageIsEmpty` (VW-68). */
export function EmptyLiveView({ model }: { model: DashboardModel }): ReactElement {
  const { session, connection } = model;
  // A KNOWN disconnect (the mapper folded a real connection status that says so). Undefined
  // connection = unknown ⇒ do NOT claim disconnected; the shell owns the authoritative banner.
  const disconnected = connection?.connected === false;

  const { icon, title, description } = disconnected
    ? {
        icon: BluetoothIcon,
        title: 'No Voltra connected',
        description:
          'Connect a Voltra — live velocity, tempo and fatigue appear here once a set begins.',
      }
    : session.hasSession
      ? {
          // A session is open — name it (a real name, or the neutral `Exercise N` ordinal;
          // the mapper never emits a bare em-dash here — VW-68).
          icon: DumbbellIcon,
          title: `Ready · ${session.exerciseName}`,
          description: 'Start the first set — live velocity, tempo and fatigue will appear here.',
        }
      : {
          icon: DumbbellIcon,
          title: 'Waiting for a set',
          description: 'Start a set on the machine or from the MCP to see live velocity here.',
        };

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
      <EmptyState icon={icon} title={title} description={description} />
      {/* Loaded weight — a real device echo (the plates currently on the cable). Shown only when
          the settings cascade reported one; hidden under the mock adapter, never a fabricated 0.
          Suppressed on a known disconnect (a stale weight would mislead). */}
      {!disconnected && session.weightLbs !== null && (
        <MetricGroup>
          <Metric size="md" value={String(session.weightLbs)} unit={session.unit} label="Loaded" />
        </MetricGroup>
      )}
    </View>
  );
}
