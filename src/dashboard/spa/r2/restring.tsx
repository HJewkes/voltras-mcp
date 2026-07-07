/**
 * RestRing — NET-NEW shell component.
 * **Candidate titan `RestTimer` ring variant** (concrete ticket seed).
 *
 * Direction C's "beautiful timer": a large SVG ring countdown with the
 * remaining seconds as the center numeral. The real titan RestTimer renders a
 * compact linear bar and cannot take this form; the harness shows both (ring
 * as C's hero treatment, real RestTimer below for the displayOnly behavior).
 */
import React from 'react';

export function RestRing({
  totalSeconds,
  elapsedMs,
}: {
  totalSeconds: number;
  elapsedMs: number;
}): React.JSX.Element {
  const remaining = Math.max(0, totalSeconds - Math.floor(elapsedMs / 1000));
  const frac = totalSeconds > 0 ? remaining / totalSeconds : 0;
  const R = 100;
  const CIRC = 2 * Math.PI * R;
  return (
    <div className="r2-restring" role="timer" aria-label={`Rest: ${remaining} seconds remaining`}>
      <svg viewBox="0 0 220 220">
        <circle cx="110" cy="110" r={R} fill="none" stroke="#20232a" strokeWidth="10" />
        <circle
          cx="110"
          cy="110"
          r={R}
          fill="none"
          stroke="var(--color-brand-primary, #ff7900)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - frac)}
          transform="rotate(-90 110 110)"
        />
      </svg>
      <div className="r2-restring-num">
        <span className="r2-restring-t">{remaining}</span>
        <span className="r2-restring-k">seconds</span>
      </div>
    </div>
  );
}
