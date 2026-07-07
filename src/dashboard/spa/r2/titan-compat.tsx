/**
 * Type-compat casts for titan props that exist on titan main / v0.5.0 but not
 * in the npm 0.4.0 install this repo compiles against.
 *
 * - RestTimer `displayOnly` — titan #81 (v0.5.0)
 * - VelocityStrip `zones` + `liveRepIndex` — titan #83 (v0.5.0): WA-shaped
 *   cable zone bands + latest-bar-only live pop/bounce
 *
 * With TITAN_DIST (local titan-main dist) the props are honored for real; on
 * the npm 0.4.0 fallback they are ignored (RestTimer buttons get the CSS
 * fallback; VelocityStrip falls back to its built-in barbell scale).
 */
import type React from 'react';
import {
  RestTimer,
  VelocityStrip,
  type RestTimerProps,
  type VelocityStripProps,
} from '@titan-design/react-ui';

/** Shape-compatible with WA `VelocityZones.bands` (titan #83 prop). */
export interface VelocityZoneBandProp {
  id: string;
  label: string;
  min: number;
  max: number | null;
}

export const RestTimerCompat = RestTimer as React.ComponentType<
  RestTimerProps & { displayOnly?: boolean }
>;

export const VelocityStripCompat = VelocityStrip as React.ComponentType<
  VelocityStripProps & {
    zones?: readonly VelocityZoneBandProp[];
    liveRepIndex?: number;
  }
>;
