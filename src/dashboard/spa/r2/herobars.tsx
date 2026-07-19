/**
 * HeroVelocityBars — NET-NEW shell component.
 * **Candidate titan `VelocityStrip 'hero' variant`** (concrete ticket seed).
 *
 * The real VelocityStrip's expanded form is compact (~100px, info footer) and
 * cannot stretch to Direction C's wall-scale hero proportions — the gap
 * flagged in component-audit.md. This renders C's hero treatment: full-height
 * per-rep bars that fill the viewport vertically, value labels, running-best
 * reference line, pending-rep placeholders, and a latest-bar-only pop.
 * Zone colors come from the SAME WA-shaped bands the real VelocityStrip
 * consumes (titan #83), so hero and strip agree on zoning.
 */
import React from 'react';
import type { VelocityZoneBandProp } from './titan-compat';

const ZONE_SCALE: Record<string, string> = {
  speed: '#2ed573',
  power: '#ffd43b',
  'strength-speed': '#ffa502',
  strength: '#ff4757',
};

function zoneColor(v: number, zones: readonly VelocityZoneBandProp[]): string {
  for (const z of zones) {
    if (v >= z.min && (z.max == null || v < z.max)) return ZONE_SCALE[z.id] ?? '#8d95a3';
  }
  return '#8d95a3';
}

export function HeroVelocityBars({
  velocities,
  targetReps,
  zones,
}: {
  velocities: number[];
  targetReps: number;
  zones: readonly VelocityZoneBandProp[];
}): React.JSX.Element {
  const best = velocities.length ? Math.max(...velocities) : 0;
  const scale = Math.max(best * 1.1, 0.2);
  const refBottom = best > 0 ? (best / scale) * 100 : null;
  return (
    <div className="r2-herobars" role="img" aria-label="Per-rep velocity, hero scale">
      {refBottom != null && (
        <div className="r2-herobars-ref" style={{ bottom: `${refBottom * 0.94}%` }}>
          <span>best {best.toFixed(2)}</span>
        </div>
      )}
      {velocities.map((v, i) => (
        <div
          key={i}
          className={`r2-herobar${i === velocities.length - 1 ? ' pop' : ''}`}
          style={{ height: `${(v / scale) * 94}%`, background: zoneColor(v, zones) }}
        >
          <span className="r2-herobar-lab">{v.toFixed(2)}</span>
        </div>
      ))}
      {Array.from({ length: Math.max(0, targetReps - velocities.length) }, (_, k) => (
        <div key={`p${k}`} className="r2-herobar pending" />
      ))}
    </div>
  );
}

export function heroZoneColor(v: number, zones: readonly VelocityZoneBandProp[]): string {
  return zoneColor(v, zones);
}
