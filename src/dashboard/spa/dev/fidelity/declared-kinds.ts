// SPA-local components the owner declares as honest empty states (VW-799), so the fidelity build
// tags them `placeholder` instead of `spa`. Keys are `repo/relative/path.tsx#ComponentName`.
// Seeded empty: entries are added by name, never inferred. Production source carries no markers.

export type DeclaredKind = 'placeholder';

export type DeclaredKinds = Readonly<Record<string, DeclaredKind>>;

export const DECLARED_KINDS: DeclaredKinds = {};
