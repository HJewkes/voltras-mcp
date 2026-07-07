/**
 * Program + Body framed stubs.
 *
 * Program: labeled skeleton with the REAL WeekRow + WorkoutCard placed in
 * their slots (the redesign itself is future work — prior HTML cribs).
 * Body: REAL MuscleGroupChip grid; tapping a muscle opens the REAL titan
 * Drawer hosting the REAL BodyMapDetailPanel — whose shipped content model
 * (MEV/MRV landmarks, weekly-history sparkline, contributing exercises,
 * upcoming) IS the per-muscle drawer fill named in the component audit.
 */
import React, { useState } from 'react';
import { Drawer, Heading, MuscleGroupChip, WeekRow, WorkoutCard } from '@titan-design/react-ui';
import { BodyMapDetailPanel, MuscleGroup } from '@titan-design/react-ui/bodymap';
import { MUSCLES, PROGRAM, SESSION } from './fixture';
import { F } from './fidelity';

export function ProgramStub(): React.JSX.Element {
  return (
    <div className="r2-stub">
      <div className="r2-stub-head">
        <Heading level={2}>Program · {PROGRAM.name}</Heading>
        <span className="r2-stub-tag">
          STUB · framed skeleton — redesign from program-planning cribs
        </span>
      </div>
      <div className="r2-stub-grid">
        <F kind="mock" name="block rail slot">
          <div className="r2-stub-slot">
            Column 1 · Blocks — Accumulation /{' '}
            <b>
              Intensification (wk {PROGRAM.mesoWeek}/{PROGRAM.mesoTotal})
            </b>{' '}
            / Realization
          </div>
        </F>
        <div>
          <div className="r2-panel-label">Column 2 · Weeks (real WeekRow)</div>
          <F kind="real" name="titan:WeekRow">
            <WeekRow
              weekNumber={PROGRAM.weekNumber}
              totalWeeks={PROGRAM.totalWeeks}
              intensityLevel={0.72}
              isCurrent
              workouts={[
                { name: 'Push A', status: 'completed' },
                { name: 'Pull A', status: 'current' },
                { name: 'Push B', status: 'next' },
                { name: 'Pull B', status: 'upcoming' },
              ]}
            />
          </F>
        </div>
        <div>
          <div className="r2-panel-label">Column 3 · Workout detail (real WorkoutCard)</div>
          <F kind="real" name="titan:WorkoutCard">
            <WorkoutCard
              name="Pull A"
              date="2026-07-06"
              duration="48 min"
              status="today"
              muscleGroups={[
                { group: 'back', label: 'Back', volumeStatus: 'over' },
                { group: 'chest', label: 'Chest', volumeStatus: 'productive' },
                { group: 'rear_delts', label: 'Rear Delt', volumeStatus: 'under' },
              ]}
              totalSets={SESSION.reduce((n, e) => n + e.sets.length, 0)}
              totalVolume={7340}
              unit="lbs"
            />
          </F>
        </div>
      </div>
    </div>
  );
}

/** The barrel and /bodymap subpath ship two different VolumeStatus enums. */
const BODYMAP_STATUS: Record<string, 'under' | 'maintenance' | 'productive' | 'over'> = {
  untrained: 'under',
  behind: 'under',
  ontrack: 'productive',
  target: 'productive',
  over: 'over',
};
const MUSCLE_ENUM: Record<string, MuscleGroup> = {
  lats: MuscleGroup.LATS,
  chest: MuscleGroup.CHEST,
  quads: MuscleGroup.QUADS,
  abs: MuscleGroup.ABS,
};

export function BodyStub(): React.JSX.Element {
  const [openMuscle, setOpenMuscle] = useState<string | null>(null);
  const m = MUSCLES.find((x) => x.name === openMuscle) ?? null;
  return (
    <div className="r2-stub">
      <div className="r2-stub-head">
        <Heading level={2}>Body · weekly volume &amp; recovery</Heading>
        <span className="r2-stub-tag">
          STUB · full-body render slot (titan:BodyMap) — tap a muscle for the real detail panel
        </span>
      </div>
      <F
        kind="mock"
        name="BodyMap slot"
        note="real titan:BodyMap exists — omitted to keep the harness bundle light"
      >
        <div className="r2-stub-slot r2-body-slot">
          full-body front/back SVG · titan:BodyMap (lazy chunk in the shipping dashboard)
        </div>
      </F>
      <div className="r2-body-chips">
        {MUSCLES.map((mu) => (
          <F key={mu.name} kind="real" name="titan:MuscleGroupChip" block={false}>
            <MuscleGroupChip
              name={mu.displayName}
              volumeStatus={mu.volumeStatus}
              onPress={() => setOpenMuscle(mu.name)}
            />
          </F>
        ))}
      </div>
      <F kind="real" name="titan:Drawer (right) + BodyMapDetailPanel">
        <Drawer
          isOpen={m != null}
          onClose={() => setOpenMuscle(null)}
          placement="right"
          title={m?.displayName ?? ''}
        >
          {m != null && (
            <BodyMapDetailPanel
              muscleGroup={MUSCLE_ENUM[m.name] ?? MuscleGroup.LATS}
              displayName={m.displayName}
              weeklySets={m.weeklySets}
              landmarks={m.landmarks}
              volumeStatus={BODYMAP_STATUS[m.volumeStatus] ?? 'productive'}
              lastTrained={m.lastTrained}
              weeklyHistory={m.weeklyHistory}
              contributingExercises={m.contributing}
              upcomingExercises={m.upcoming}
              isOpen
              onClose={() => setOpenMuscle(null)}
            />
          )}
        </Drawer>
      </F>
    </div>
  );
}

export function IdleView(): React.JSX.Element {
  return (
    <div className="r2-stub">
      <div className="r2-stub-head">
        <Heading level={2}>Wall idle · between sessions</Heading>
        <span className="r2-stub-tag">idle is a STATE of Live, not a tab</span>
      </div>
      <F kind="mock" name="idle wall content">
        <div className="r2-stub-slot">
          next workout · capacity trend · body state — wakes to the live hero when the first set
          streams
        </div>
      </F>
    </div>
  );
}
