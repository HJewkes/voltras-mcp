// Every TrueCoach DOM selector this tool depends on, in one file.
//
// GATE: any DOM selector change fails closed. If one expected element is
// missing, nothing is filled and nothing is submitted; there are no partial
// posts. Each caller checks for absence and aborts the whole entry — no
// selector below has a "best effort" fallback, deliberately.
//
// Provenance: the exercise-card triple and the tab buttons are transcribed
// from mcummins/hevy-truecoach-sync's runbook (its DOM table is dated
// 2026-08-21, the button-label note 2026-08-31). No code was vendored.

export const WORKOUTS_URL = 'https://app.truecoach.co/client/workouts?_=true';

/** One card per programmed exercise, in display order. */
export const EXERCISE_CARD = 'li.workoutDisplay-exercise';

/** Within a card. `RESULTS_TEXTAREA` is the only element this tool writes to. */
export const EXERCISE_TITLE = 'h4[data-test="workout-item-title"]';
export const EXERCISE_PLAN = 'p.til';
export const RESULTS_TEXTAREA = 'textarea[placeholder="Enter results"]';

/** Upcoming / Past. The label sits in an sr-only span, so match textContent. */
export const TAB_BUTTON = 'button[role="tab"]';

/** Workout cards on the list page link to `/client/workouts/<id>`. */
export const WORKOUT_LINK = 'a[href*="/client/workouts/"]';

/**
 * The results submit control.
 *
 * UNVERIFIED. Nobody on this side has clicked it. hevy-truecoach-sync
 * deliberately stops before submitting and leaves the human to press it, so
 * its runbook records the label but never exercises the click. The label also
 * depends on workout state: a workout with every exercise still pending reads
 * `Finish workout`, and one with completed exercises reads `Update results`.
 * Both submit the same form, so both are accepted here.
 *
 * The first human dry run is the verification step: read the screenshot, look
 * at the button the page actually renders, and correct this constant before
 * the first `--submit`.
 */
export const SUBMIT_CONTROL = Object.freeze({
  selector: 'button',
  labels: Object.freeze(['update results', 'finish workout']),
});

/** Set on the submit button by the page script so Playwright can click it. */
export const SUBMIT_MARKER = 'data-vmcp-submit';

/** A login form or MFA challenge. Any hit stops the whole run. */
export const LOGIN_SIGNALS = Object.freeze([
  'input[type="password"]',
  'input[name="otp"]',
  'input[autocomplete="one-time-code"]',
]);
