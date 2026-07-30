/**
 * Session-planning / builder page (VW-120).
 *
 * Two panels over the plan REST surface:
 *
 *   * LEFT — the exercise catalog (`GET /api/exercises`), browsable and
 *     searchable, each row a one-click "add to this workout".
 *   * RIGHT — the workout currently being planned: the program's workouts, the
 *     selected one's ordered planned exercises, and inline controls to add,
 *     retarget, and reorder them.
 *
 * The tree re-polls every {@link PLANNER_POLL_INTERVAL_MS}, so lifts an agent
 * adds over MCP (`plan.exercise.create`) appear here without a reload — see
 * `planner-client.ts` for why this is a poll and not an SSE subscription.
 * `resolveSelectedTemplateId` keeps the operator's selection pinned across those
 * polls so a refresh never yanks the editor out from under an edit.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useStore } from 'zustand';

import { dashboardStore } from '../store';
import {
  addPlannedExercise,
  createProgram,
  createWorkout,
  fetchCatalog,
  fetchPlanTree,
  reorderPlannedExercises,
  updatePlannedExercise,
  PLANNER_POLL_INTERVAL_MS,
} from './planner-client';
import {
  flattenTemplates,
  prescriptionLine,
  resolveSelectedTemplateId,
  type FlatTemplate,
} from './planner-model';
import { styles } from './planner-styles';
import type { DashboardCatalogEntry } from '../../read-models/catalog-entry';
import type { PlanExerciseView } from '../../read-models/plan-tree';

/** Muscle-group filter chips. Sourced from the loaded catalog, never hard-coded. */
function muscleOptions(catalog: readonly DashboardCatalogEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of catalog) for (const m of entry.muscleGroups) seen.add(m);
  return [...seen].sort();
}

export function PlanBuilderPage(): React.JSX.Element {
  const planTree = useStore(dashboardStore, (s) => s.planTree);
  const catalog = useStore(dashboardStore, (s) => s.catalog);
  const error = useStore(dashboardStore, (s) => s.plannerError);

  const [programId, setProgramId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [muscle, setMuscle] = useState('');
  const [allMuscles, setAllMuscles] = useState<string[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const tree = await fetchPlanTree(programId);
      dashboardStore.getState().applyPlanner({ planTree: tree, plannerError: null });
    } catch (err) {
      dashboardStore.getState().applyPlanner({ plannerError: (err as Error).message });
    }
  }, [programId]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), PLANNER_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const entries = await fetchCatalog(query, muscle);
        if (cancelled) return;
        dashboardStore.getState().applyPlanner({ catalog: entries });
        // The unfiltered load is the only complete view of the catalog, so the
        // chip list is captured from it and kept while filters narrow the rows.
        if (query === '' && muscle === '') setAllMuscles(muscleOptions(entries));
      } catch (err) {
        if (!cancelled) {
          dashboardStore.getState().applyPlanner({ plannerError: (err as Error).message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, muscle]);

  const templates = flattenTemplates(planTree);
  const activeTemplateId = planTree?.activeTemplateId ?? null;
  const templateId = resolveSelectedTemplateId(templates, selectedTemplateId, activeTemplateId);
  const selected = templates.find((t) => t.template.id === templateId) ?? null;

  const mutate = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      await refresh();
    } catch (err) {
      dashboardStore.getState().applyPlanner({ plannerError: (err as Error).message });
    }
  };

  return (
    <div>
      <ProgramBar
        programs={planTree?.programs ?? []}
        programId={planTree?.program?.id ?? null}
        onSelect={setProgramId}
        onCreate={(name) => void mutate(() => createProgram({ name }))}
      />
      {error !== null && <p style={styles.error}>{error}</p>}
      <div style={styles.columns}>
        <div style={styles.column}>
          <CatalogPanel
            catalog={catalog}
            muscles={allMuscles}
            query={query}
            muscle={muscle}
            onQuery={setQuery}
            onMuscle={setMuscle}
            canAdd={templateId !== null}
            onAdd={(exerciseId) =>
              void mutate(() => addPlannedExercise(templateId as string, { exerciseId }))
            }
          />
        </div>
        <div style={styles.column}>
          <WorkoutList
            templates={templates}
            selectedId={templateId}
            activeId={activeTemplateId}
            onSelect={setSelectedTemplateId}
            onCreate={
              planTree?.program == null
                ? null
                : (name) =>
                    void mutate(() => createWorkout(planTree.program?.id as string, { name }))
            }
          />
          {selected !== null && (
            <WorkoutEditor
              flat={selected}
              onAddTargets={(id, patch) => void mutate(() => updatePlannedExercise(id, patch))}
              onReorder={(ids) =>
                void mutate(() => reorderPlannedExercises(selected.template.id, ids))
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ProgramBar(props: {
  programs: readonly { id: string; name: string; archived: boolean }[];
  programId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  return (
    <div style={styles.card}>
      <h2 style={styles.heading}>Program</h2>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          style={styles.input}
          value={props.programId ?? ''}
          onChange={(e) => props.onSelect(e.target.value)}
        >
          {props.programs.length === 0 && <option value="">No programs yet</option>}
          {props.programs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.archived ? ' (archived)' : ''}
            </option>
          ))}
        </select>
        <input
          style={styles.input}
          placeholder="New program name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          style={styles.buttonPrimary}
          disabled={name.trim() === ''}
          onClick={() => {
            props.onCreate(name.trim());
            setName('');
          }}
        >
          Create program
        </button>
      </div>
    </div>
  );
}

function CatalogPanel(props: {
  catalog: readonly DashboardCatalogEntry[];
  muscles: readonly string[];
  query: string;
  muscle: string;
  onQuery: (q: string) => void;
  onMuscle: (m: string) => void;
  canAdd: boolean;
  onAdd: (exerciseId: string) => void;
}): React.JSX.Element {
  return (
    <div style={styles.card}>
      <h2 style={styles.heading}>Exercise catalog</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          style={{ ...styles.input, flex: 1 }}
          placeholder="Search exercises"
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
        />
        <select
          style={styles.input}
          value={props.muscle}
          onChange={(e) => props.onMuscle(e.target.value)}
        >
          <option value="">All muscles</option>
          {props.muscles.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      <p style={styles.subtle}>
        {props.catalog.length} exercise{props.catalog.length === 1 ? '' : 's'}
        {props.canAdd ? '' : ' · select a workout to add'}
      </p>
      <div style={{ maxHeight: 520, overflowY: 'auto' }}>
        {props.catalog.map((entry) => (
          <div key={entry.id} style={styles.row}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>{entry.name}</div>
              <div style={styles.subtle}>
                {entry.muscleGroups.join(', ')}
                {entry.movementPattern === undefined ? '' : ` · ${entry.movementPattern}`}
              </div>
            </div>
            <button
              style={styles.button}
              disabled={!props.canAdd}
              onClick={() => props.onAdd(entry.id)}
            >
              Add
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkoutList(props: {
  templates: readonly FlatTemplate[];
  selectedId: string | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Null when there is no program to add a workout to. */
  onCreate: ((name: string) => void) | null;
}): React.JSX.Element {
  const [name, setName] = useState('');
  return (
    <div style={styles.card}>
      <h2 style={styles.heading}>Workouts</h2>
      {props.templates.length === 0 && (
        <p style={styles.subtle}>No workouts yet — create a program, then add one.</p>
      )}
      {props.templates.map(({ template, blockName, weekName }) => (
        <div key={template.id} style={styles.row}>
          <button
            style={template.id === props.selectedId ? styles.buttonPrimary : styles.button}
            onClick={() => props.onSelect(template.id)}
          >
            {template.name}
          </button>
          <span style={styles.subtle}>
            {blockName} · {weekName} · {template.exercises.length} exercises
            {template.id === props.activeId ? ' · training now' : ''}
            {template.completed ? ' · completed' : ''}
          </span>
        </div>
      ))}
      {props.onCreate !== null && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            style={{ ...styles.input, flex: 1 }}
            placeholder="New workout name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            style={styles.button}
            disabled={name.trim() === ''}
            onClick={() => {
              props.onCreate?.(name.trim());
              setName('');
            }}
          >
            Add workout
          </button>
        </div>
      )}
    </div>
  );
}

function WorkoutEditor(props: {
  flat: FlatTemplate;
  onAddTargets: (
    plannedExerciseId: string,
    patch: {
      targetSets?: number;
      targetRepsLow?: number;
      targetRepsHigh?: number;
      targetWeightLbs?: number;
    },
  ) => void;
  onReorder: (plannedExerciseIds: string[]) => void;
}): React.JSX.Element {
  const { template } = props.flat;
  const ids = template.exercises.map((e) => e.id);
  const move = (index: number, delta: number): void => {
    const next = [...ids];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    props.onReorder(next);
  };
  return (
    <div style={styles.card}>
      <h2 style={styles.heading}>{template.name} — planned exercises</h2>
      {template.exercises.length === 0 && (
        <p style={styles.subtle}>Empty. Add lifts from the catalog, or let the agent fill it in.</p>
      )}
      {template.exercises.map((exercise, index) => (
        <PlannedExerciseRow
          key={exercise.id}
          exercise={exercise}
          onUp={index === 0 ? null : () => move(index, -1)}
          onDown={index === ids.length - 1 ? null : () => move(index, 1)}
          onSave={(patch) => props.onAddTargets(exercise.id, patch)}
        />
      ))}
    </div>
  );
}

/** Parse a form field into a number, treating blank as "leave unchanged". */
function numberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function PlannedExerciseRow(props: {
  exercise: PlanExerciseView;
  onUp: (() => void) | null;
  onDown: (() => void) | null;
  onSave: (patch: {
    targetSets?: number;
    targetRepsLow?: number;
    targetRepsHigh?: number;
    targetWeightLbs?: number;
  }) => void;
}): React.JSX.Element {
  const { exercise } = props;
  const [sets, setSets] = useState('');
  const [repsLow, setRepsLow] = useState('');
  const [repsHigh, setRepsHigh] = useState('');
  const [weight, setWeight] = useState('');

  const save = (): void => {
    const patch = {
      ...(numberOrUndefined(sets) !== undefined ? { targetSets: numberOrUndefined(sets) } : {}),
      ...(numberOrUndefined(repsLow) !== undefined
        ? { targetRepsLow: numberOrUndefined(repsLow) }
        : {}),
      ...(numberOrUndefined(repsHigh) !== undefined
        ? { targetRepsHigh: numberOrUndefined(repsHigh) }
        : {}),
      ...(numberOrUndefined(weight) !== undefined
        ? { targetWeightLbs: numberOrUndefined(weight) }
        : {}),
    };
    props.onSave(patch);
    setSets('');
    setRepsLow('');
    setRepsHigh('');
    setWeight('');
  };

  return (
    <div style={styles.row}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>
          {exercise.orderIndex + 1}. {exercise.name}
        </div>
        <div style={styles.subtle}>{prescriptionLine(exercise)}</div>
      </div>
      <input
        style={{ ...styles.input, width: 52 }}
        placeholder="sets"
        value={sets}
        onChange={(e) => setSets(e.target.value)}
      />
      <input
        style={{ ...styles.input, width: 52 }}
        placeholder="lo"
        value={repsLow}
        onChange={(e) => setRepsLow(e.target.value)}
      />
      <input
        style={{ ...styles.input, width: 52 }}
        placeholder="hi"
        value={repsHigh}
        onChange={(e) => setRepsHigh(e.target.value)}
      />
      <input
        style={{ ...styles.input, width: 64 }}
        placeholder="lb"
        value={weight}
        onChange={(e) => setWeight(e.target.value)}
      />
      <button style={styles.button} onClick={save}>
        Save
      </button>
      <button style={styles.button} disabled={props.onUp === null} onClick={() => props.onUp?.()}>
        ↑
      </button>
      <button
        style={styles.button}
        disabled={props.onDown === null}
        onClick={() => props.onDown?.()}
      >
        ↓
      </button>
    </div>
  );
}
