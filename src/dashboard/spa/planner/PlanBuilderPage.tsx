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
 *
 * ── Styling ────────────────────────────────────────────────────────────────
 * Built from `@titan-design/react-ui` primitives, same as the live page — the
 * first cut used plain DOM + inline styles on the argument that operator
 * surfaces don't need the design system, which just produced a second, worse
 * visual language two routes from the first.
 *
 * The one rule inherited from the live page: LAYOUT goes through `style`, never
 * `className`. titan components are react-native-web Views, which silently drop
 * Tailwind layout utilities (`flex-1`, `flex-row`) while honouring colour ones.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useStore } from 'zustand';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Caption,
  Divider,
  EmptyState,
  Input,
  LayersIcon,
  MuscleGroupChip,
  Pill,
  Select,
  Surface,
  Typography,
} from '@titan-design/react-ui';

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
import type { DashboardCatalogEntry } from '../../read-models/catalog-entry';
import type { PlanExerciseView } from '../../read-models/plan-tree';

/** Page gutter. One constant so every panel on both planner routes aligns. */
export const PAGE_PADDING = 20;

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
    <Surface level="background" style={{ minHeight: '100%', padding: PAGE_PADDING, gap: 16 }}>
      <ProgramBar
        programs={planTree?.programs ?? []}
        programId={planTree?.program?.id ?? null}
        onSelect={setProgramId}
        onCreate={(name) => void mutate(() => createProgram({ name }))}
      />
      {error !== null && <ErrorNote message={error} />}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
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
        <div
          style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}
        >
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
    </Surface>
  );
}

/** A failed mutation/poll, in the design system's error colour. Shared by both pages. */
export function ErrorNote(props: { message: string }): React.JSX.Element {
  return (
    <Card variant="outline" borderColor="var(--color-status-error)">
      <CardContent>
        <Typography variant="body2" color="error">
          {props.message}
        </Typography>
      </CardContent>
    </Card>
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
    <Card variant="elevated">
      <CardHeader>
        <CardTitle>Program</CardTitle>
      </CardHeader>
      <CardContent>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ minWidth: 220 }}>
            <Select
              variant="filled"
              placeholder={props.programs.length === 0 ? 'No programs yet' : 'Select a program'}
              value={props.programId}
              options={props.programs.map((p) => ({
                value: p.id,
                label: p.archived ? `${p.name} (archived)` : p.name,
              }))}
              onChange={(value) => {
                if (value !== null) props.onSelect(value);
              }}
            />
          </div>
          <div style={{ minWidth: 200 }}>
            <Input
              variant="filled"
              size="sm"
              placeholder="New program name"
              value={name}
              onChangeText={setName}
            />
          </div>
          <Button
            size="sm"
            isDisabled={name.trim() === ''}
            onPress={() => {
              props.onCreate(name.trim());
              setName('');
            }}
          >
            Create program
          </Button>
        </div>
      </CardContent>
    </Card>
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
    <Card variant="elevated">
      <CardHeader>
        <CardTitle>Exercise catalog</CardTitle>
      </CardHeader>
      <CardContent>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <div style={{ flex: '1 1 0', minWidth: 0 }}>
            <Input
              variant="filled"
              size="sm"
              placeholder="Search exercises"
              value={props.query}
              onChangeText={props.onQuery}
            />
          </div>
          <div style={{ width: 180 }}>
            <Select
              variant="filled"
              placeholder="All muscles"
              value={props.muscle === '' ? null : props.muscle}
              options={props.muscles.map((m) => ({ value: m, label: m }))}
              onChange={(value) => props.onMuscle(value ?? '')}
            />
          </div>
        </div>
        <Caption color="tertiary">
          {props.catalog.length} exercise{props.catalog.length === 1 ? '' : 's'}
          {props.canAdd ? '' : ' · select a workout to add'}
        </Caption>
        {props.catalog.length === 0 ? (
          <EmptyState
            title="No exercises match"
            description="Clear the search or pick a different muscle group."
          />
        ) : (
          <div style={{ maxHeight: 520, overflowY: 'auto', marginTop: 8 }}>
            {props.catalog.map((entry) => (
              <CatalogRow
                key={entry.id}
                entry={entry}
                canAdd={props.canAdd}
                onAdd={() => props.onAdd(entry.id)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CatalogRow(props: {
  entry: DashboardCatalogEntry;
  canAdd: boolean;
  onAdd: () => void;
}): React.JSX.Element {
  const { entry } = props;
  return (
    <>
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          paddingTop: 8,
          paddingBottom: 8,
        }}
      >
        <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Typography variant="body2">{entry.name}</Typography>
          {/* Muscle groups are the seam a future body-map filter plugs into: the
              chips are already the same taxonomy a body region would select on,
              so filtering by region means feeding `onMuscle` a different value,
              not restructuring this row. */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
            {entry.muscleGroups.map((m) => (
              <MuscleGroupChip key={m} name={m} />
            ))}
            {entry.movementPattern !== undefined && (
              <Pill size="sm" variant="outline">
                {entry.movementPattern}
              </Pill>
            )}
          </div>
        </div>
        <Button size="sm" variant="outline" isDisabled={!props.canAdd} onPress={props.onAdd}>
          Add
        </Button>
      </div>
      <Divider />
    </>
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
    <Card variant="elevated">
      <CardHeader>
        <CardTitle>Workouts</CardTitle>
      </CardHeader>
      <CardContent>
        {props.templates.length === 0 ? (
          <EmptyState
            icon={LayersIcon}
            title="No workouts yet"
            description="Create a program, then add a workout to plan into."
          />
        ) : (
          props.templates.map(({ template, blockName, weekName }) => (
            <div
              key={template.id}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                paddingTop: 6,
                paddingBottom: 6,
              }}
            >
              <Button
                size="sm"
                variant={template.id === props.selectedId ? 'solid' : 'outline'}
                onPress={() => props.onSelect(template.id)}
              >
                {template.name}
              </Button>
              <div style={{ flex: '1 1 0', minWidth: 0 }}>
                <Caption color="tertiary">
                  {blockName} · {weekName} · {template.exercises.length} exercises
                </Caption>
              </div>
              {template.id === props.activeId && (
                <Badge color="success" variant="subtle" dot>
                  training now
                </Badge>
              )}
              {template.completed && (
                <Badge color="default" variant="subtle">
                  completed
                </Badge>
              )}
            </div>
          ))
        )}
        {props.onCreate !== null && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            <div style={{ flex: '1 1 0', minWidth: 0 }}>
              <Input
                variant="filled"
                size="sm"
                placeholder="New workout name"
                value={name}
                onChangeText={setName}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              isDisabled={name.trim() === ''}
              onPress={() => {
                props.onCreate?.(name.trim());
                setName('');
              }}
            >
              Add workout
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
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
    <Card variant="elevated">
      <CardHeader>
        <CardTitle>{template.name} — planned exercises</CardTitle>
      </CardHeader>
      <CardContent>
        {template.exercises.length === 0 ? (
          <EmptyState
            title="Nothing planned yet"
            description="Add lifts from the catalog, or let the agent fill it in over MCP."
          />
        ) : (
          template.exercises.map((exercise, index) => (
            <PlannedExerciseRow
              key={exercise.id}
              exercise={exercise}
              onUp={index === 0 ? null : () => move(index, -1)}
              onDown={index === ids.length - 1 ? null : () => move(index, 1)}
              onSave={(patch) => props.onAddTargets(exercise.id, patch)}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

/** Parse a form field into a number, treating blank as "leave unchanged". */
function numberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A narrow numeric target field. titan has no number-stepper primitive (see gap note). */
function TargetInput(props: {
  placeholder: string;
  width: number;
  value: string;
  onChange: (next: string) => void;
}): React.JSX.Element {
  return (
    <div style={{ width: props.width }}>
      <Input
        variant="filled"
        size="sm"
        inputMode="numeric"
        placeholder={props.placeholder}
        value={props.value}
        onChangeText={props.onChange}
      />
    </div>
  );
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
    <>
      {/* Two lines, not one: the exercise NAME is the row's identity and earns the
          full width, while the four target fields are a secondary edit affordance.
          Squeezing both onto one line wrapped every name to three lines. */}
      <div style={{ paddingTop: 10, paddingBottom: 10 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Column flow, explicitly: react-native-web renders Text as an inline
              box, so a stacked name + caption run together on one line without it. */}
          <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <Typography variant="body2">
              {exercise.orderIndex + 1}. {exercise.name}
            </Typography>
            <Caption color="tertiary">{prescriptionLine(exercise)}</Caption>
          </div>
          {/* Reorder is two nudge buttons, not a drag handle: titan ships no
              drag-reorder primitive (see the component-gap note), and inventing a
              one-off DnD here is exactly the kind of thing this rebuild removes. */}
          <Button
            size="sm"
            variant="ghost"
            isIconButton
            isDisabled={props.onUp === null}
            onPress={() => props.onUp?.()}
          >
            ↑
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isIconButton
            isDisabled={props.onDown === null}
            onPress={() => props.onDown?.()}
          >
            ↓
          </Button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <TargetInput placeholder="sets" width={58} value={sets} onChange={setSets} />
          <TargetInput placeholder="lo" width={50} value={repsLow} onChange={setRepsLow} />
          <TargetInput placeholder="hi" width={50} value={repsHigh} onChange={setRepsHigh} />
          <TargetInput placeholder="lb" width={64} value={weight} onChange={setWeight} />
          <Button size="sm" variant="outline" onPress={save}>
            Save targets
          </Button>
        </div>
      </div>
      <Divider />
    </>
  );
}
