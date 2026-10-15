// How the capability reference groups tool namespaces by domain (VMCP-07.08).
//
// The sidebar and the index both read this one table, so a namespace sits in
// the same group everywhere. A namespace missing from it is filed under
// `OTHER_GROUP` and reported, never dropped.

export interface ReferenceGroup {
  readonly title: string;
  readonly namespaces: readonly string[];
}

export const REFERENCE_GROUPS: readonly ReferenceGroup[] = [
  { title: 'Device and rig', namespaces: ['device', 'slot', 'bilateral'] },
  { title: 'Recording', namespaces: ['session', 'set', 'exercise', 'timer', 'isometric'] },
  {
    title: 'Analytics',
    namespaces: ['metrics', 'rir_velocity', 'baselines', 'driftguard', 'mrvguard', 'progression'],
  },
  { title: 'Planning and goals', namespaces: ['plan', 'goal', 'profile', 'accountability'] },
  { title: 'Coaching and reports', namespaces: ['coaching', 'report', 'truecoach'] },
  { title: 'Server and diagnostics', namespaces: ['server', 'system', 'debug', 'mock'] },
];

export const OTHER_GROUP = 'Other';

export interface GroupedNamespaces {
  readonly groups: readonly ReferenceGroup[];
  /** Namespaces the table does not name, in registry order. */
  readonly unmapped: readonly string[];
}

/**
 * The registry's namespaces laid out in `REFERENCE_GROUPS` order. A group with
 * no registered namespace is left out; unmapped namespaces form a trailing
 * `OTHER_GROUP`.
 */
export function groupNamespaces(registered: readonly string[]): GroupedNamespaces {
  const present = new Set(registered);
  const mapped = new Set(REFERENCE_GROUPS.flatMap((group) => group.namespaces));
  const groups = REFERENCE_GROUPS.map((group) => ({
    title: group.title,
    namespaces: group.namespaces.filter((namespace) => present.has(namespace)),
  })).filter((group) => group.namespaces.length > 0);
  const unmapped = registered.filter((namespace) => !mapped.has(namespace));
  if (unmapped.length > 0) groups.push({ title: OTHER_GROUP, namespaces: unmapped });
  return { groups, unmapped };
}
