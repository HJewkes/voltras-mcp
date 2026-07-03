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

export function BodyMapPanel({ data }: { data: BodyMapData[] }): React.JSX.Element {
  const [view, setView] = useState<'front' | 'back'>('front');
  const [highlighted, setHighlighted] = useState<MuscleGroup | null>(null);

  const onMusclePress = (muscle: MuscleGroup): void => {
    setHighlighted((prev) => (prev === muscle ? null : muscle));
  };

  return (
    <PanelCard title="Muscle heatmap">
      <BodyMap
        data={data}
        view={view}
        onViewChange={setView}
        onMusclePress={onMusclePress}
        highlightedMuscle={highlighted}
        mode="simple"
      />
    </PanelCard>
  );
}
