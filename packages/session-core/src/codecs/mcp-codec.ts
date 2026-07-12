/**
 * MCP `SessionCodec` — maps the relational `SessionStore` shape (`StoredSession` +
 * `StoredSet[]`) to/from the canonical `WorkoutSession`.
 *
 * Reps are already WA `Rep`s → strip row metadata (`{id,setId,index,derived}`) into
 * `analytics.reps` + an index-aligned `repMeta[]`. Timestamps ISO ⇄ EpochMs at this
 * boundary. `status` is derived from `endedAt` + set `partial`.
 *
 * Lossy direction: `load.chains` / `load.eccentric` have NO columns here — the codec
 * flattens to a single `weightLbs`. Use {@link detectMcpLossyLoad} before a write to
 * surface non-zero chains/ecc that would be dropped.
 */

import type { Set as WASet, Rep as WARep } from '@voltras/workout-analytics';
import type { CanonicalSet, CanonicalWorkoutSession } from '../canonical.js';
import type { LoadSettings, SessionStatus } from '../types.js';
import type { SessionCodec } from '../repository.js';
import type { McpStored, McpStoredRep, McpStoredSet } from './stored-shapes.js';

/** Drop MCP row metadata (`id`/`setId`/`index`/`derived`) via object-rest, keeping the WA
 *  `Rep` core so `analytics.reps` never carries platform columns (`satisfies Rep` invariant). */
function stripRowMeta(rep: McpStoredRep): WARep {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, setId, index, derived, ...wa } = rep;
  return wa;
}

function deriveStatus(endedAt: number | null, sets: McpStoredSet[]): SessionStatus {
  if (endedAt === null) return 'in_progress';
  return sets.some((s) => s.partial === true) ? 'abandoned' : 'completed';
}

function isoToMs(iso: string): number {
  return Date.parse(iso);
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

export const mcpCodec: SessionCodec<McpStored> = {
  toCanonical({ session, sets, assignments }: McpStored): CanonicalWorkoutSession {
    const endedAt = session.endedAt ? isoToMs(session.endedAt) : null;

    const canonicalSets: CanonicalSet[] = sets.map((set, index) => {
      const load: LoadSettings = { weight: set.weightLbs, chains: 0, eccentric: 0 };
      const analytics: WASet = {
        reps: set.reps.map(stripRowMeta),
        loadSettings: load,
      };
      return {
        id: set.id,
        index,
        startedAt: isoToMs(set.startedAt),
        endedAt: set.endedAt ? isoToMs(set.endedAt) : null,
        load,
        analytics,
        partial: set.partial,
        partialReason: set.partialReason,
        trainingMode: set.trainingMode,
        repMeta: set.reps.map((r) => ({ id: r.id, derivedVbt: r.derived })),
      };
    });

    return {
      id: session.id,
      exerciseId: session.exerciseId,
      exerciseName: session.exerciseName,
      startedAt: isoToMs(session.startedAt),
      endedAt,
      status: deriveStatus(endedAt, sets),
      sets: canonicalSets,
      notes: session.notes,
      extra:
        assignments && assignments.length > 0
          ? { mcp: { programAssignments: assignments } }
          : undefined,
    };
  },

  fromCanonical(session: CanonicalWorkoutSession): McpStored {
    const sets: McpStoredSet[] = session.sets.map((cs) => {
      const reps: McpStoredRep[] = cs.analytics.reps.map((rep: WARep, i: number) => {
        const meta = cs.repMeta?.[i];
        return {
          ...rep,
          id: meta?.id ?? `${cs.id}-rep-${i}`,
          setId: cs.id,
          index: i,
          derived: meta?.derivedVbt,
        };
      });
      return {
        id: cs.id,
        sessionId: session.id,
        startedAt: msToIso(cs.startedAt),
        endedAt: cs.endedAt === null ? null : msToIso(cs.endedAt),
        weightLbs: cs.load.weight, // chains/eccentric intentionally dropped — see detectMcpLossyLoad
        trainingMode: cs.trainingMode,
        partial: cs.partial,
        partialReason: cs.partialReason,
        reps,
      };
    });

    const assignments = session.extra?.mcp?.['programAssignments'] as unknown[] | undefined;

    return {
      session: {
        id: session.id,
        exerciseId: session.exerciseId,
        exerciseName: session.exerciseName,
        startedAt: msToIso(session.startedAt),
        endedAt: session.endedAt === null ? null : msToIso(session.endedAt),
        notes: session.notes,
      },
      sets,
      assignments,
    };
  },
};

export interface McpLossyLoadWarning {
  setId: string;
  field: 'chains' | 'eccentric';
  value: number;
}

/** Surface non-zero `load.chains` / `load.eccentric` that an MCP write would silently drop
 *  (no columns). Callers park them in `extra` or warn before persisting. */
export function detectMcpLossyLoad(session: CanonicalWorkoutSession): McpLossyLoadWarning[] {
  const warnings: McpLossyLoadWarning[] = [];
  for (const set of session.sets) {
    if (set.load.chains) warnings.push({ setId: set.id, field: 'chains', value: set.load.chains });
    if (set.load.eccentric)
      warnings.push({ setId: set.id, field: 'eccentric', value: set.load.eccentric });
  }
  return warnings;
}
