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
 * Planes come from the grey ramp via `PanelCard` (`Surface level="raised"`),
 * NOT titan's `Card` — see `PanelCard.tsx` for the measurement that forced
 * that. Spacing comes from `design.ts`'s 4px scale, never a typed-in pixel.
 *
 * The one rule inherited from the live page: LAYOUT goes through `style`, never
 * `className`. titan components are react-native-web Views, which silently drop
 * Tailwind layout utilities (`flex-1`, `flex-row`) while honouring colour ones.
 * That rule is also why the responsive breakpoint is a JS `matchMedia` value
 * (`useIsNarrowViewport`) rather than a `sm:` class — see `use-viewport.ts`.
 *
 * ── Write safety (VW-121) ──────────────────────────────────────────────────
 * Every mutation funnels through ONE {@link PlanBuilderPage.mutate} that holds a
 * ref-guarded in-flight latch, because the first cut let a double-click on a
 * catalog row's "Add" fire two creates before React re-rendered — and shipped no
 * delete, so the duplicates were permanent. The latch closes the first half; the
 * per-row Remove control closes the second.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  Badge,
  Button,
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
  deletePlannedExercise,
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
import { useIsNarrowViewport } from '../use-viewport';
import { ButtonLabel, PANEL_GAP, PanelCard } from './PanelCard';
import { CONTROL_HEIGHT, QUIET_ACTION_BORDER, SPACE, TARGET_FIELD_WIDTH } from './design';
import { createMutationLatch, MIN_LATCH_HOLD_MS } from './mutation-latch';
import { parseTargetFields, type TargetPatch } from './target-fields';
import type { DashboardCatalogEntry } from '../../read-models/catalog-entry';
import type { PlanExerciseView } from '../../read-models/plan-tree';

/** Page gutter. One constant so every panel on both planner routes aligns. */
export const PAGE_PADDING = SPACE.lg;

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
  const narrow = useIsNarrowViewport();

  const [programId, setProgramId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [muscle, setMuscle] = useState('');
  const [allMuscles, setAllMuscles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // The de-dup guard. `busy` drives the disabled styling, but a real
  // double-click lands two `onPress`es inside ONE React tick, so both would read
  // the pre-render `busy === false` — the latch is written synchronously and is
  // the only thing standing between an impatient click and a duplicate row.
  const latchRef = useRef<ReturnType<typeof createMutationLatch> | null>(null);
  latchRef.current ??= createMutationLatch({
    onBusyChange: setBusy,
    onError: (err) => dashboardStore.getState().applyPlanner({ plannerError: err.message }),
    minHoldMs: MIN_LATCH_HOLD_MS,
  });

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

  /**
   * Run one write, then reconcile. Resolves TRUE when the write landed, so a
   * caller can clear its form only on success — and FALSE when the latch dropped
   * the call, which is the whole de-dup guard.
   *
   * The RECONCILE runs inside the latch, not after it. Releasing on the POST's
   * response would re-enable the button while the list is still showing the
   * pre-write state — i.e. exactly the window in which a user clicks again
   * because nothing appeared to happen. The button stays down until the row the
   * click created is on screen.
   */
  const mutate = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      const latch = latchRef.current as ReturnType<typeof createMutationLatch>;
      return latch.run(async () => {
        await fn();
        await refresh();
      });
    },
    [refresh],
  );

  const catalogPanel = (
    <CatalogPanel
      catalog={catalog}
      muscles={allMuscles}
      query={query}
      muscle={muscle}
      onQuery={setQuery}
      onMuscle={setMuscle}
      canAdd={templateId !== null && !busy}
      onAdd={(exerciseId) =>
        void mutate(() => addPlannedExercise(templateId as string, { exerciseId }))
      }
    />
  );
  const workoutColumn = (
    <>
      <WorkoutList
        templates={templates}
        selectedId={templateId}
        activeId={activeTemplateId}
        busy={busy}
        onSelect={setSelectedTemplateId}
        onCreate={
          planTree?.program == null
            ? null
            : (name) => void mutate(() => createWorkout(planTree.program?.id as string, { name }))
        }
      />
      {selected !== null && (
        <WorkoutEditor
          flat={selected}
          busy={busy}
          onAddTargets={(id, patch) => mutate(() => updatePlannedExercise(id, patch))}
          onRemove={(id) => mutate(() => deletePlannedExercise(id))}
          onReorder={(ids) => void mutate(() => reorderPlannedExercises(selected.template.id, ids))}
        />
      )}
    </>
  );

  // `base`, not `background`: the shell's own plane is `base` (#252321), so a
  // `background` page (#1C1916) put the content in a pit DARKER than its own
  // frame — which is why the cards had to be so bright to read at all.
  return (
    <Surface level="base" style={{ minHeight: '100%', padding: PAGE_PADDING, gap: PANEL_GAP }}>
      <ProgramBar
        programs={planTree?.programs ?? []}
        programId={planTree?.program?.id ?? null}
        busy={busy}
        onSelect={setProgramId}
        onCreate={(name) => void mutate(() => createProgram({ name }))}
      />
      {error !== null && <ErrorNote message={error} />}
      {/* Below the breakpoint the two columns STACK rather than squeeze: at phone
          width the right column collapsed to ~110px and wrapped its caption one
          character per line, which is a broken page, not a cramped one. */}
      <div
        style={{
          display: 'flex',
          flexDirection: narrow ? 'column' : 'row',
          gap: PANEL_GAP,
          alignItems: narrow ? 'stretch' : 'flex-start',
        }}
      >
        <div style={{ flex: '1 1 0', minWidth: 0 }}>{catalogPanel}</div>
        <div
          style={{
            flex: '1 1 0',
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: PANEL_GAP,
          }}
        >
          {workoutColumn}
        </div>
      </div>
    </Surface>
  );
}

/** A failed mutation/poll, in the design system's error colour. Shared by both pages. */
export function ErrorNote(props: { message: string }): React.JSX.Element {
  return (
    <PanelCard borderColor="var(--color-status-error)">
      <Typography variant="body2" color="error">
        {props.message}
      </Typography>
    </PanelCard>
  );
}

function ProgramBar(props: {
  programs: readonly { id: string; name: string; archived: boolean }[];
  programId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  return (
    <PanelCard title="Program">
      <div style={{ display: 'flex', gap: SPACE.xs, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 220 }}>
          <Select
            variant="filled"
            aria-label="Program"
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
            aria-label="New program name"
            placeholder="New program name"
            value={name}
            onChangeText={setName}
          />
        </div>
        <Button
          size="sm"
          style={{ height: CONTROL_HEIGHT }}
          isDisabled={name.trim() === '' || props.busy}
          onPress={() => {
            props.onCreate(name.trim());
            setName('');
          }}
        >
          <ButtonLabel tone="on-solid">Create program</ButtonLabel>
        </Button>
      </div>
    </PanelCard>
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
    <PanelCard title="Exercise catalog">
      <div style={{ display: 'flex', gap: SPACE.xs, marginBottom: SPACE.sm, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <Input
            variant="filled"
            size="sm"
            aria-label="Search exercises"
            placeholder="Search exercises"
            value={props.query}
            onChangeText={props.onQuery}
          />
        </div>
        <div style={{ width: 180 }}>
          <Select
            variant="filled"
            aria-label="Filter by muscle group"
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
        <div style={{ maxHeight: 520, overflowY: 'auto', marginTop: SPACE.xs }}>
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
    </PanelCard>
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
          gap: SPACE.sm,
          alignItems: 'center',
          paddingTop: SPACE.xs,
          paddingBottom: SPACE.xs,
        }}
      >
        <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Typography variant="body2">{entry.name}</Typography>
          {/* Muscle groups are the seam a future body-map filter plugs into: the
              chips are already the same taxonomy a body region would select on,
              so filtering by region means feeding `onMuscle` a different value,
              not restructuring this row. */}
          <div
            style={{
              display: 'flex',
              gap: SPACE.xxs,
              flexWrap: 'wrap',
              marginTop: SPACE.xxs,
            }}
          >
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
        {/* A quiet repeated action: `ghost` + a neutral hairline, NOT the
            brand-orange `outline` this shipped with — 30 orange pills down the
            catalog gave every row the weight of a primary action. The name goes
            IN the accessible name, because 30 buttons that all announce "Add"
            give a screen-reader user no way to tell them apart (D3). */}
        <Button
          size="sm"
          variant="ghost"
          style={{ height: CONTROL_HEIGHT, ...QUIET_ACTION_BORDER }}
          aria-label={`Add ${entry.name}`}
          isDisabled={!props.canAdd}
          onPress={props.onAdd}
        >
          <ButtonLabel>Add</ButtonLabel>
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
  busy: boolean;
  onSelect: (id: string) => void;
  /** Null when there is no program to add a workout to. */
  onCreate: ((name: string) => void) | null;
}): React.JSX.Element {
  const [name, setName] = useState('');
  return (
    <PanelCard title="Workouts">
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
              gap: SPACE.xs,
              alignItems: 'center',
              flexWrap: 'wrap',
              paddingTop: SPACE.xxs,
              paddingBottom: SPACE.xxs,
            }}
          >
            <Button
              size="sm"
              variant={template.id === props.selectedId ? 'solid' : 'ghost'}
              style={{ height: CONTROL_HEIGHT }}
              aria-label={`Edit workout ${template.name}`}
              onPress={() => props.onSelect(template.id)}
            >
              <ButtonLabel tone={template.id === props.selectedId ? 'on-solid' : 'on-surface'}>
                {template.name}
              </ButtonLabel>
            </Button>
            <div style={{ flex: '1 1 120px', minWidth: 0 }}>
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
        <div
          style={{
            display: 'flex',
            gap: SPACE.xs,
            marginTop: SPACE.sm,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: '1 1 140px', minWidth: 0 }}>
            <Input
              variant="filled"
              size="sm"
              aria-label="New workout name"
              placeholder="New workout name"
              value={name}
              onChangeText={setName}
            />
          </div>
          {/* `outline`: unlike the catalog's repeated "Add", this is the one
              action of its row, so it is allowed to carry the brand. */}
          <Button
            size="sm"
            variant="outline"
            style={{ height: CONTROL_HEIGHT }}
            isDisabled={name.trim() === '' || props.busy}
            onPress={() => {
              props.onCreate?.(name.trim());
              setName('');
            }}
          >
            <ButtonLabel>Add workout</ButtonLabel>
          </Button>
        </div>
      )}
    </PanelCard>
  );
}

function WorkoutEditor(props: {
  flat: FlatTemplate;
  busy: boolean;
  onAddTargets: (plannedExerciseId: string, patch: TargetPatch) => Promise<boolean>;
  onRemove: (plannedExerciseId: string) => Promise<boolean>;
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
    <PanelCard title={`${template.name} — planned exercises`}>
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
            busy={props.busy}
            onUp={index === 0 ? null : () => move(index, -1)}
            onDown={index === ids.length - 1 ? null : () => move(index, 1)}
            onSave={(patch) => props.onAddTargets(exercise.id, patch)}
            onRemove={() => props.onRemove(exercise.id)}
          />
        ))
      )}
    </PanelCard>
  );
}

/** A narrow numeric target field. titan has no number-stepper primitive (see gap note). */
function TargetInput(props: {
  /** Accessible name. Placeholder-as-label is a WCAG failure — it vanishes on input (D2). */
  label: string;
  placeholder: string;
  value: string;
  invalid: boolean;
  onChange: (next: string) => void;
}): React.JSX.Element {
  return (
    // One width for all four: `sets` / `lo` / `hi` / `lb` are peers holding
    // 1-3 digits each, and the old 58/50/50/64 was four different answers to
    // the same question.
    <div style={{ width: TARGET_FIELD_WIDTH }}>
      <Input
        variant="filled"
        size="sm"
        inputMode="numeric"
        aria-label={props.label}
        isInvalid={props.invalid}
        placeholder={props.placeholder}
        value={props.value}
        onChangeText={props.onChange}
      />
    </div>
  );
}

/** How long the post-save "Saved" confirmation stays up (F7). */
const SAVED_FLASH_MS = 2000;

function PlannedExerciseRow(props: {
  exercise: PlanExerciseView;
  busy: boolean;
  onUp: (() => void) | null;
  onDown: (() => void) | null;
  onSave: (patch: TargetPatch) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}): React.JSX.Element {
  const { exercise } = props;
  const [sets, setSets] = useState('');
  const [repsLow, setRepsLow] = useState('');
  const [repsHigh, setRepsHigh] = useState('');
  const [weight, setWeight] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Removing a planned lift is destructive and irreversible, so it is two
  // deliberate clicks — NOT a window.confirm(), which blocks the whole page.
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    if (!saved) return undefined;
    const id = setTimeout(() => setSaved(false), SAVED_FLASH_MS);
    return () => clearTimeout(id);
  }, [saved]);

  const save = (): void => {
    const parsed = parseTargetFields(
      { sets, repsLow, repsHigh, weight },
      {
        targetRepsLow: exercise.targetRepsLow,
        targetRepsHigh: exercise.targetRepsHigh,
      },
    );
    if (!parsed.ok) {
      setFieldError(parsed.message);
      setSaved(false);
      return;
    }
    if (parsed.empty) {
      setFieldError('Nothing to save — fill in at least one target.');
      return;
    }
    setFieldError(null);
    void (async () => {
      // Only a write that actually LANDED clears the boxes. The old version
      // cleared unconditionally, so a rejected save looked identical to a
      // successful one: four empty fields and no other signal.
      if (!(await props.onSave(parsed.patch))) return;
      setSets('');
      setRepsLow('');
      setRepsHigh('');
      setWeight('');
      setSaved(true);
    })();
  };

  return (
    <>
      {/* Two lines, not one: the exercise NAME is the row's identity and earns the
          full width, while the four target fields are a secondary edit affordance.
          Squeezing both onto one line wrapped every name to three lines. */}
      <div style={{ paddingTop: SPACE.sm, paddingBottom: SPACE.sm }}>
        <div style={{ display: 'flex', gap: SPACE.xs, alignItems: 'center' }}>
          {/* Column flow, explicitly: react-native-web renders Text as an inline
              box, so a stacked name + caption run together on one line without it. */}
          <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {/* `body1`, not `body2`: this is the row's identity and the largest
                thing in it, so it should not share a size with the catalog's
                secondary listing text. */}
            <Typography variant="body1">
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
            aria-label={`Move ${exercise.name} up`}
            isDisabled={props.onUp === null || props.busy}
            onPress={() => props.onUp?.()}
          >
            <ButtonLabel>↑</ButtonLabel>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            isIconButton
            aria-label={`Move ${exercise.name} down`}
            isDisabled={props.onDown === null || props.busy}
            onPress={() => props.onDown?.()}
          >
            <ButtonLabel>↓</ButtonLabel>
          </Button>
          {confirmingRemove ? (
            <>
              <Button
                size="sm"
                variant="solid"
                color="error"
                style={{ height: CONTROL_HEIGHT }}
                aria-label={`Confirm removing ${exercise.name} from this workout`}
                isDisabled={props.busy}
                onPress={() => {
                  void (async () => {
                    await props.onRemove();
                    setConfirmingRemove(false);
                  })();
                }}
              >
                <ButtonLabel tone="on-solid">Remove?</ButtonLabel>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                style={{ height: CONTROL_HEIGHT }}
                aria-label={`Keep ${exercise.name} in this workout`}
                onPress={() => setConfirmingRemove(false)}
              >
                <ButtonLabel>Cancel</ButtonLabel>
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              isIconButton
              aria-label={`Remove ${exercise.name} from this workout`}
              isDisabled={props.busy}
              onPress={() => setConfirmingRemove(true)}
            >
              <ButtonLabel>✕</ButtonLabel>
            </Button>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            gap: SPACE.xs,
            alignItems: 'center',
            marginTop: SPACE.xs,
            flexWrap: 'wrap',
          }}
        >
          <TargetInput
            label={`Sets for ${exercise.name}`}
            placeholder="sets"
            value={sets}
            invalid={fieldError !== null}
            onChange={setSets}
          />
          <TargetInput
            label={`Rep range low for ${exercise.name}`}
            placeholder="lo"
            value={repsLow}
            invalid={fieldError !== null}
            onChange={setRepsLow}
          />
          <TargetInput
            label={`Rep range high for ${exercise.name}`}
            placeholder="hi"
            value={repsHigh}
            invalid={fieldError !== null}
            onChange={setRepsHigh}
          />
          <TargetInput
            label={`Weight in pounds for ${exercise.name}`}
            placeholder="lb"
            value={weight}
            invalid={fieldError !== null}
            onChange={setWeight}
          />
          {/* The one action that commits this row's four fields — it earns the
              brand outline the repeated catalog "Add" gave up. */}
          <Button
            size="sm"
            variant="outline"
            style={{ height: CONTROL_HEIGHT }}
            aria-label={`Save targets for ${exercise.name}`}
            isDisabled={props.busy}
            onPress={save}
          >
            <ButtonLabel>Save targets</ButtonLabel>
          </Button>
          {saved && (
            <Typography variant="body2" color="success">
              ✓ Saved
            </Typography>
          )}
        </div>
        {fieldError !== null && (
          <div style={{ marginTop: SPACE.xxs }}>
            <Typography variant="body2" color="error">
              {fieldError}
            </Typography>
          </div>
        )}
      </div>
      <Divider />
    </>
  );
}
