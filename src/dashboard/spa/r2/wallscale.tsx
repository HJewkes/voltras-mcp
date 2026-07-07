/**
 * WallScale — candidate-variant prototyping wrapper.
 *
 * Renders the REAL titan component's own DOM scaled up for the 2–3 m wall
 * (CSS transform, width-compensated, container height measured from the
 * unscaled child so layout stays correct). Because the child is the actual
 * library component — not a redraw — every capability and structural detail
 * (segments, pacing ✓/✗ marks, labels) is provably identical; the wrapper is
 * a stand-in for a proposed `size`/`density` prop on the component itself,
 * NOT a fork. Cross-form-factor policy: mobile keeps current sizes; the wall
 * opts into the bigger rendering via the prop this prototypes.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';

export function WallScale({
  factor,
  children,
}: {
  factor: number;
  children: React.ReactNode;
}): React.JSX.Element {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = (): void => setHeight(el.getBoundingClientRect().height * factor);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [factor]);

  return (
    <div style={{ height, overflow: 'visible' }}>
      <div
        ref={innerRef}
        style={{
          transform: `scale(${factor})`,
          transformOrigin: 'top left',
          width: `${100 / factor}%`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
