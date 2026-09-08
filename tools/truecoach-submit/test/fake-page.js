// A jsdom-backed stand-in for a Playwright page.
//
// `evaluate` recompiles the real page source inside the jsdom window, so the
// scripts under test are the ones that ship — the fake replaces the browser,
// not the code being exercised. No network, no chromium.

import { JSDOM } from 'jsdom';

const EDIT_URL = 'https://app.truecoach.co/client/workouts/1/edit';

export function fakePage(html, { url = EDIT_URL } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url });
  const calls = { goto: [], click: [], screenshot: [], tabs: [] };
  return {
    dom,
    calls,
    url: () => dom.window.location.href,
    goto: async (target) => void calls.goto.push(target),
    evaluate: async (fn, payload) => dom.window.eval(`(${fn.toString()})`)(payload),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    click: async (selector) => void calls.click.push(selector),
    screenshot: async ({ path }) => void calls.screenshot.push(path),
    locator: (selector, options) => locator(dom, calls, selector, options),
  };
}

/** Enough of Playwright's locator for `.first().count()` / `.first().click()`. */
function locator(dom, calls, selector, options) {
  const matches = [...dom.window.document.querySelectorAll(selector)].filter(
    (el) => options?.hasText === undefined || options.hasText.test((el.textContent ?? '').trim()),
  );
  const one = {
    count: async () => (matches.length > 0 ? 1 : 0),
    click: async () => void calls.tabs.push((matches[0]?.textContent ?? '').trim()),
  };
  return { count: async () => matches.length, first: () => one };
}

/** A `chromium`-shaped launcher that hands `runAll` the page it is given. */
export function fakeLauncher(page) {
  return {
    launchPersistentContext: async () => ({
      pages: () => [page],
      newPage: async () => page,
      close: async () => {},
    }),
  };
}

/** For runs that must settle without a page pass at all. */
export function forbiddenLauncher() {
  return {
    launchPersistentContext: async () => {
      throw new Error('a browser was launched for an entry that needed no page pass');
    },
  };
}

export function card(title, { plan = '', box = true } = {}) {
  const textarea = box ? '<textarea placeholder="Enter results"></textarea>' : '';
  return (
    '<li class="workoutDisplay-exercise">' +
    `<h4 data-test="workout-item-title">${title}</h4><p class="til">${plan}</p>${textarea}</li>`
  );
}
