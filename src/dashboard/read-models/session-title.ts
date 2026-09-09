// Pure read-model: compose the session-block title (VW-43).
//
// Takes the plain strings `fetchSessionPlan` already resolves from the store
// (template name, and the attached block's name/focus) and composes the
// display string — no store access, no I/O. Mirrors the "block · context"
// house style `fetchNextWorkout` already uses for its idle preview (`server.ts`).

export interface SessionTitleInput {
  templateName?: string | undefined;
  blockName?: string | undefined;
  focus?: string | undefined;
}

/**
 * `"Push A · Hypertrophy"` when a focus is set, `"Push A · Hypertrophy Block 1"`
 * when only a block name is, or bare `"Push A"` with neither. Null when there is
 * no template name to title from — never a fabricated placeholder.
 */
export function composeSessionTitle({
  templateName,
  blockName,
  focus,
}: SessionTitleInput): string | null {
  if (templateName === undefined || templateName === '') return null;
  const suffix =
    focus !== undefined && focus !== ''
      ? focus.charAt(0).toUpperCase() + focus.slice(1)
      : blockName;
  return suffix === undefined || suffix === '' ? templateName : `${templateName} · ${suffix}`;
}
