// Driving one TrueCoach workout page: find it, read its slots, fill them,
// screenshot it, submit it.
//
// Every lookup here fails closed. A missing tab button, a missing card, two
// cards for one day, a card whose results box has gone — each throws
// `AbortEntry` before anything is typed.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { assertLoggedIn, evalIn } from './browser.js';
import { longCardDate } from './date.js';
import { AbortEntry } from './errors.js';
import { DIR_MODE } from './paths.js';
import {
  EXTRACT_SLOTS_SOURCE,
  FILL_SLOTS_SOURCE,
  FIND_WORKOUT_SOURCE,
  MARK_SUBMIT_SOURCE,
} from './page.js';
import {
  EXERCISE_CARD,
  RESULTS_TEXTAREA,
  SUBMIT_CONTROL,
  SUBMIT_MARKER,
  TAB_BUTTON,
  WORKOUTS_URL,
} from './selectors.js';

const SPA_SETTLE_MS = 3000;
const IDLE_TIMEOUT_MS = 15_000;

/** Upcoming first: a same-day workout stays there until the coach closes it. */
const TAB_ORDER = ['upcoming', 'past'];

export async function openWorkout(page, date) {
  await page.goto(WORKOUTS_URL, { waitUntil: 'domcontentloaded' });
  await settle(page);
  await assertLoggedIn(page);
  const needle = longCardDate(date);
  for (const tab of TAB_ORDER) {
    await selectTab(page, tab);
    const hits = await evalIn(page, FIND_WORKOUT_SOURCE, needle);
    if (hits.length === 1) return openEditPage(page, hits[0]);
    if (hits.length > 1) {
      throw new AbortEntry('workout_not_found', `${hits.length} workouts dated ${needle}`);
    }
  }
  throw new AbortEntry('workout_not_found', `no workout dated ${needle} under Upcoming or Past`);
}

async function openEditPage(page, href) {
  const base = href.replace(/\/+$/, '');
  await page.goto(base.endsWith('/edit') ? base : `${base}/edit`, {
    waitUntil: 'domcontentloaded',
  });
  await settle(page);
  await assertLoggedIn(page);
  return page.url();
}

async function selectTab(page, label) {
  const tab = page.locator(TAB_BUTTON, { hasText: new RegExp(`^\\s*${label}`, 'i') }).first();
  if ((await tab.count()) === 0) {
    throw new AbortEntry('selector_missing', `no "${label}" tab matching \`${TAB_BUTTON}\``);
  }
  await tab.click();
  await settle(page);
}

/** Every card on the workout, in display order. */
export async function readSlots(page) {
  const slots = await evalIn(page, EXTRACT_SLOTS_SOURCE, null);
  if (slots.length === 0) {
    throw new AbortEntry('selector_missing', `no exercise cards matching \`${EXERCISE_CARD}\``);
  }
  return slots;
}

/** `fills` is `[{ index, block }]`. Fills all of them or none of them. */
export async function fillSlots(page, fills) {
  const outcome = await evalIn(page, FILL_SLOTS_SOURCE, fills);
  if (outcome.filled !== fills.length) {
    throw new AbortEntry(
      'selector_missing',
      `card ${outcome.missingAt} has no \`${RESULTS_TEXTAREA}\``,
    );
  }
  return outcome.filled;
}

export async function captureScreenshot(page, paths, sessionId) {
  mkdirSync(paths.screens, { recursive: true, mode: DIR_MODE });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(paths.screens, `${sessionId}-${stamp}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

/** One click, or no click at all. Never a retry — a retry can double-post. */
export async function clickSubmit(page) {
  const marked = await evalIn(page, MARK_SUBMIT_SOURCE, {
    selector: SUBMIT_CONTROL.selector,
    labels: [...SUBMIT_CONTROL.labels],
  });
  if (!marked) {
    throw new AbortEntry(
      'selector_missing',
      `no submit control labelled ${SUBMIT_CONTROL.labels.join(' / ')}`,
    );
  }
  await page.click(`[${SUBMIT_MARKER}="1"]`);
  await settle(page);
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(SPA_SETTLE_MS);
}
