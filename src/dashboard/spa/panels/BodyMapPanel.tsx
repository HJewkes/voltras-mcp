/**
 * BodyMap panel (Phase 3 — VMCP-01.47).
 *
 * The live muscle-SVG heatmap: titan-design's `BodyMap` (react-native-body-
 * highlighter under react-native-web) lit by the CURRENT exercise's target
 * muscles. Front/back toggle and muscle-tap highlight are local view state; the
 * heatmap data is derived from the snapshot each render.
 *
 * `bodymap` / `@titan-design/react-ui` pull `react-native-body-highlighter` +
 * `react-native-svg`, resolved for the browser by the SPA vite build only, so
 * this component is reached solely through the vite bundle (never node vitest).
 */
import { useState } from 'react';
import { BodyMap, type BodyMapData, type MuscleGroup } from '@titan-design/react-ui';
import { PanelCard } from './PanelCard';

export function BodyMapPanel({
  data,
  weeklyData,
}: {
  /** Live heatmap: muscles worked by the current exercise. */
  data: BodyMapData[];
  /** Weekly-volume heatmap: MEV/MAV/MRV status over the trailing week. */
  weeklyData: BodyMapData[];
}): React.JSX.Element {
  const [view, setView] = useState<'front' | 'back'>('front');
  const [mode, setMode] = useState<'live' | 'weekly'>('live');
  const [highlighted, setHighlighted] = useState<MuscleGroup | null>(null);

  const onMusclePress = (muscle: MuscleGroup): void => {
    setHighlighted((prev) => (prev === muscle ? null : muscle));
  };

  const hasWeekly = weeklyData.length > 0;
  const shown = mode === 'weekly' && hasWeekly ? weeklyData : data;

  return (
    <PanelCard title="Muscle heatmap">
      {hasWeekly && (
        <div className="bodymap-mode" role="group" aria-label="Heatmap mode">
          <button
            type="button"
            className={mode === 'live' ? 'is-active' : ''}
            aria-pressed={mode === 'live'}
            onClick={() => setMode('live')}
          >
            Live
          </button>
          <button
            type="button"
            className={mode === 'weekly' ? 'is-active' : ''}
            aria-pressed={mode === 'weekly'}
            onClick={() => setMode('weekly')}
          >
            Weekly volume
          </button>
        </div>
      )}
      <BodyMap
        data={shown}
        view={view}
        onViewChange={setView}
        onMusclePress={onMusclePress}
        highlightedMuscle={highlighted}
        mode="simple"
      />
    </PanelCard>
  );
}
