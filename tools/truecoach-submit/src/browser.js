// The browser: one persistent profile, headless for real runs, headed once for
// login.
//
// This tool never types a password. `truecoach-submit login` opens a window for
// the human to sign in and pass MFA by hand; every later run reuses the cookies
// that left behind. If an unattended run still lands on a login form, that is a
// stop condition for the whole run, not something to retry around.

import { mkdirSync } from 'node:fs';

import { DIR_MODE } from './paths.js';
import { DETECT_LOGIN_SOURCE } from './page.js';
import { LOGIN_SIGNALS, WORKOUTS_URL } from './selectors.js';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export class LoginRequiredError extends Error {
  constructor(where) {
    super(`TrueCoach is asking for a login at ${where}. Run \`truecoach-submit login\` first.`);
    this.name = 'LoginRequiredError';
  }
}

/** Runs `source` as `new Function('payload', source)` inside the page. */
export function evalIn(page, source, payload) {
  return page.evaluate(new Function('payload', source), payload);
}

export async function openContext(profileDir, { headless = true, launcher } = {}) {
  mkdirSync(profileDir, { recursive: true, mode: DIR_MODE });
  const chromium = launcher ?? (await import('playwright')).chromium;
  return chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1440, height: 1800 },
  });
}

export async function firstPage(context) {
  return context.pages()[0] ?? (await context.newPage());
}

/** Throws `LoginRequiredError` rather than returning, so no caller can ignore it. */
export async function assertLoggedIn(page) {
  const url = page.url();
  if (/\/(login|sign_in|sessions\/new)/.test(url)) throw new LoginRequiredError(url);
  if (await evalIn(page, DETECT_LOGIN_SOURCE, LOGIN_SIGNALS)) throw new LoginRequiredError(url);
}

/** Headed sign-in. Returns when the human closes the window. */
export async function runLogin(paths) {
  const context = await openContext(paths.profile, { headless: false });
  const page = await firstPage(context);
  await page.goto(WORKOUTS_URL, { waitUntil: 'domcontentloaded' });
  console.error('Sign in (and pass MFA) in the window, then close it. Nothing is typed for you.');
  await waitForClose(context);
  console.error(`Session stored in ${paths.profile}. Next: a dry run.`);
}

function waitForClose(context) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => void context.close().then(resolve, resolve), LOGIN_WINDOW_MS);
    context.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
