// The checks behind `npm run sweep` (scripts/persona-sweep.mjs), kept pure so
// `src/__tests__/sweep-checks.test.ts` can run them on planted strings.
//
// Every check returns a list of findings and never throws: one bad page must not
// hide the rest of the run. A finding is `{ kind, detail, ...where }`, where
// `where` is whatever locates it (persona, route, viewport, unit, endpoint, tool).

/**
 * Text that only reaches a page or a tool result when a value went missing or
 * was formatted raw. Each is matched as a whole word, so "Nancy" and "nullable"
 * pass while "NaN%" and "null kg" fail.
 */
export const BAD_TOKENS = [
  { token: 'NaN', pattern: /\bNaN\b/ },
  { token: 'undefined', pattern: /\bundefined\b/ },
  { token: 'Infinity', pattern: /\bInfinity\b/ },
  { token: '[object Object]', pattern: /\[object Object\]/ },
  { token: 'Invalid Date', pattern: /\bInvalid Date\b/ },
  { token: 'null', pattern: /\bnull\b/ },
];

/** A pound reading: a digit, an optional space, then `lb` or `lbs` as a word. */
export const LB_READING = /\d\s?lbs?\b/gi;

/** A field or axis labelled in pounds, "Bodyweight (lbs)", which carries no digit. */
export const LB_UNIT_LABEL = /\(lbs?\)/gi;

/** A raw HTTP status the SPA prints when a fetch fails (`api-client.ts`). */
const RAW_HTTP_STATUS = /\bHTTP \d{3}\b/;

const EXCERPT_RADIUS = 30;

function excerpt(text, index, length) {
  const from = Math.max(0, index - EXCERPT_RADIUS);
  const to = Math.min(text.length, index + length + EXCERPT_RADIUS);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

/** Every bad token in `text`, once per token, with the text around its first hit. */
export function findBadTokens(text) {
  const found = [];
  for (const { token, pattern } of BAD_TOKENS) {
    const match = pattern.exec(text);
    if (match !== null) {
      found.push({
        kind: 'bad-token',
        detail: `${token}: ${excerpt(text, match.index, token.length)}`,
      });
    }
  }
  return found;
}

/**
 * A JSON string that is a raw `null` leaking into copy: the whole value, or
 * `null` read as a quantity ("null kg", "null%"). Prose that merely names null
 * ("the numeric fields are null on purpose") is fine.
 */
const NULL_IN_STRING = /^\s*null\s*$|\bnull\s?(lbs?|kg|%|reps?|sets?|s|ms)\b/;

/**
 * Bad tokens in a tool's or an endpoint's text, one finding per distinct hit.
 * JSON is walked and only its STRING values are checked: a JSON `null` is a
 * legitimate absent value, while a string reading "NaN" or "null kg" is a
 * formatting bug. Anything that is not JSON (a markdown report) is prose.
 */
export function findBadTokensInPayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return findBadTokens(text);
  }
  const strings = [];
  collectStrings(parsed, strings);
  const findings = strings.flatMap((value) =>
    findBadTokens(value).filter(
      (finding) => !finding.detail.startsWith('null:') || NULL_IN_STRING.test(value),
    ),
  );
  return uniqueFindings(findings);
}

function uniqueFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.kind} ${finding.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((item) => collectStrings(item, out));
  }
}

/** Every pound reading on a page the lifter has set to kg. */
export function findLbLeaks(text) {
  const matches = [...text.matchAll(LB_READING), ...text.matchAll(LB_UNIT_LABEL)];
  return matches.map((match) => ({
    kind: 'lb-in-kg',
    detail: excerpt(text, match.index, match[0].length),
  }));
}

/** The local calendar date of `at`, `YYYY-MM-DD`, in this process's zone. */
export function localDateOf(at) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The local Monday of the week `now` falls in, `YYYY-MM-DD`. */
export function localMondayOf(now) {
  const monday = new Date(now);
  monday.setHours(12, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return localDateOf(monday);
}

/** A "Week of" heading that names any other date than the pinned week's Monday. */
export function findWeekOfMismatch(text, expectedMonday) {
  return [...text.matchAll(/Week of (\d{4}-\d{2}-\d{2})/g)]
    .filter((match) => match[1] !== expectedMonday)
    .map((match) => ({ kind: 'week-of', detail: `"${match[0]}", expected ${expectedMonday}` }));
}

// ── per-persona expectations ───────────────────────────────────────────────

/**
 * What each persona's pages must and must not say, and which endpoints may 404.
 * A route key is a dashboard hash; `*` applies to every route. A rule is a
 * string (matched as a substring) or a RegExp.
 *
 * No persona allows a 404: an empty read answers 200 with `null` (VW-948), and
 * a 404 logs a console error on page load, which is a finding.
 */
export const EXPECTATIONS = {
  fresh: {
    routes: {
      '*': { mustNotShow: [RAW_HTTP_STATUS] },
      '#/summary': { mustShow: ['No sessions yet'] },
      '#/goals': { mustShow: ['No priorities declared'] },
    },
  },
  'first-timer': {
    routes: { '*': { mustNotShow: [RAW_HTTP_STATUS, 'No sessions yet'] } },
  },
  steady: {
    routes: {
      '*': {
        mustNotShow: [
          RAW_HTTP_STATUS,
          'No training data',
          'No priorities declared',
          'No sessions yet',
        ],
      },
      '#/body': { mustShow: ['Week of'] },
    },
  },
  plateau: {
    routes: {
      '*': { mustNotShow: [RAW_HTTP_STATUS, 'No priorities declared'] },
      '#/body': { mustShow: [/biceps/i] },
    },
  },
  'goal-mix': {
    routes: {
      '*': { mustNotShow: [RAW_HTTP_STATUS] },
      '#/goals': { mustNotShow: ['No priorities declared'] },
    },
  },
  'kg-lifter': {
    routes: {
      // Whole-kg loads stored in pounds must read back whole: 40 kg, never 39.9 kg.
      '*': { mustNotShow: [RAW_HTTP_STATUS], mustNotShowInKg: [/\b\d+\.9\d?\s?kg\b/] },
    },
  },
  'damper-band': {
    routes: {
      // A damper or isokinetic set has no load: it reads "—", never a zero load.
      '*': { mustNotShow: [RAW_HTTP_STATUS, /(^|[^\d.])0\s?(lbs?|kg)\b/i] },
    },
  },
};

/** The table used when a persona has no entry of its own. */
const DEFAULT_EXPECTATION = { routes: { '*': { mustNotShow: [RAW_HTTP_STATUS] } } };

function expectationFor(table, persona) {
  return table[persona] ?? DEFAULT_EXPECTATION;
}

function ruleMatches(rule, text) {
  return rule instanceof RegExp ? rule.test(text) : text.includes(rule);
}

function ruleLabel(rule) {
  return rule instanceof RegExp ? String(rule) : `"${rule}"`;
}

/** Every must/must-not rule a page breaks, located by persona and route. */
export function checkPageExpectations({ persona, route, unit, text }, table = EXPECTATIONS) {
  const routes = expectationFor(table, persona).routes;
  const rules = [routes['*'], routes[route]].filter((entry) => entry !== undefined);
  const findings = [];
  for (const entry of rules) {
    for (const rule of entry.mustShow ?? []) {
      if (!ruleMatches(rule, text))
        findings.push(missed(persona, route, `missing ${ruleLabel(rule)}`));
    }
    const forbidden = [
      ...(entry.mustNotShow ?? []),
      ...(unit === 'kg' ? (entry.mustNotShowInKg ?? []) : []),
    ];
    for (const rule of forbidden) {
      if (ruleMatches(rule, text))
        findings.push(missed(persona, route, `shows ${ruleLabel(rule)}`));
    }
  }
  return findings;
}

function missed(persona, route, detail) {
  return { kind: 'expectation', persona, route, detail };
}

/** A 5xx anywhere, or a 404 the persona's table does not allow. */
export function checkHttpStatus({ persona, endpoint, status }, table = EXPECTATIONS) {
  if (status >= 500) return [{ kind: 'http', persona, endpoint, detail: `status ${status}` }];
  if (status !== 404) return [];
  const allowed = expectationFor(table, persona).allow404 ?? [];
  if (allowed.includes(endpoint)) return [];
  return [{ kind: 'http', persona, endpoint, detail: 'status 404 not allowed for this persona' }];
}

// ── the MCP read tools ─────────────────────────────────────────────────────

/**
 * A tool that changes something: its last segment names a write, or it lives
 * under `debug.`/`mock.`. No allowlisted tool may match; the test pins that, so
 * a write cannot join the sweep by accident.
 */
export const WRITE_TOOL_NAME =
  /^(debug|mock)\.|\.(create|update|archive|skip|schedule|set_[a-z_]+|start|end|checkin|mark_[a-z_]+|log_[a-z_]+|declare_[a-z_]+|accept_[a-z_]+|propose_[a-z_]+|respond_[a-z_]+|retire|retire_[a-z_]+|new_chapter|mark_new_chapter|confirm_[a-z_]+|recalc|fit|import_week|complete_workout|attach_to_session|bind|unbind|identify|cascade|swap|connect|disconnect|scan|unload|wait|cancel|speak|listen_[a-z_]+|lease_acquire|lease_release|configure|configure_[a-z_]+|inject_error|enter_row_mode|start_row|start_guided_load|exit_guided_load|measure_[a-z_]+|weekly_review)$/;

/**
 * The read tools the sweep calls, and the arguments each takes from what the
 * persona's store holds (`ctx`, built by the sweep from earlier reads). A tool
 * whose `args` returns null is skipped for that persona: it needs an id the
 * store does not have. Never add a tool that writes; `debug.*` is never called.
 */
export const READ_TOOLS = [
  { name: 'server.health', args: () => ({}) },
  { name: 'device.get_state', args: () => ({}) },
  { name: 'session.list', args: () => ({ kind: 'any', limit: 200 }) },
  { name: 'session.review_list', args: () => ({}) },
  { name: 'session.get', args: (ctx) => ctx.latestSessionId && { id: ctx.latestSessionId } },
  { name: 'set.get', args: (ctx) => ctx.setId && { setId: ctx.setId } },
  { name: 'exercise.get', args: (ctx) => ctx.exerciseId && { id: ctx.exerciseId } },
  { name: 'exercise.search', args: () => ({ query: 'press' }) },
  { name: 'slot.bindings_list', args: () => ({}) },
  {
    name: 'progression.get_for_exercise',
    args: (ctx) => ctx.exerciseId && { exerciseId: ctx.exerciseId },
  },
  ...['vbt.set', 'fatigue.set'].map((pipeline) => ({
    name: 'metrics.compute',
    label: `metrics.compute ${pipeline}`,
    args: (ctx) => ctx.setId && { pipeline, setId: ctx.setId },
  })),
  ...['session.volume', 'session.fatigue', 'session.strength'].map((pipeline) => ({
    name: 'metrics.compute',
    label: `metrics.compute ${pipeline}`,
    args: (ctx) => ctx.latestSessionId && { pipeline, sessionId: ctx.latestSessionId },
  })),
  ...['strength.e1rm', 'history.trend', 'history.weekly_volume'].map((pipeline) => ({
    name: 'metrics.compute',
    label: `metrics.compute ${pipeline}`,
    args: (ctx) => ctx.exerciseId && { pipeline, exerciseId: ctx.exerciseId },
  })),
  { name: 'plan.program.list', args: () => ({}) },
  { name: 'plan.program.get', args: (ctx) => ctx.programId && { id: ctx.programId } },
  {
    name: 'plan.block.list_for_program',
    args: (ctx) => ctx.programId && { programId: ctx.programId },
  },
  { name: 'plan.block.calendar', args: (ctx) => ctx.blockId && { blockId: ctx.blockId } },
  { name: 'plan.block.schedule_history', args: (ctx) => ctx.blockId && { blockId: ctx.blockId } },
  { name: 'plan.week.list_for_block', args: (ctx) => ctx.blockId && { blockId: ctx.blockId } },
  { name: 'plan.template.list_for_week', args: (ctx) => ctx.weekId && { weekId: ctx.weekId } },
  { name: 'plan.template.get', args: (ctx) => ctx.templateId && { id: ctx.templateId } },
  {
    name: 'plan.exercise.list_for_template',
    args: (ctx) => ctx.templateId && { workoutTemplateId: ctx.templateId },
  },
  { name: 'plan.current_block', args: () => ({}) },
  { name: 'plan.block.planning_brief', args: () => ({}) },
  { name: 'plan.next_workout', args: () => ({}) },
  {
    name: 'plan.suggest_progression',
    args: (ctx) => ctx.exerciseId && { exerciseId: ctx.exerciseId },
  },
  {
    name: 'plan.warmup_ramp',
    args: (ctx) => ctx.exerciseId && { exerciseId: ctx.exerciseId, workingWeightLbs: 100 },
  },
  { name: 'profile.get_training_background', args: () => ({}) },
  { name: 'profile.get_tier_signal', args: () => ({}) },
  { name: 'profile.get_starting_prescription', args: () => ({}) },
  { name: 'profile.get_onboarding_gaps', args: () => ({}) },
  { name: 'profile.get_body_metrics', args: () => ({}) },
  { name: 'profile.get_weekly_checkin', args: () => ({}) },
  { name: 'baselines.get', args: (ctx) => ctx.exerciseId && { exerciseId: ctx.exerciseId } },
  {
    name: 'driftguard.check',
    args: (ctx) =>
      ctx.exerciseSessions.length >= 2 && {
        exerciseId: ctx.exerciseId,
        baselineSessionId: ctx.exerciseSessions.at(-2),
        currentSessionId: ctx.exerciseSessions.at(-1),
      },
  },
  {
    name: 'mrvguard.check',
    args: (ctx) =>
      ctx.exerciseSessions.length >= 3 && {
        exerciseId: ctx.exerciseId,
        session1Id: ctx.exerciseSessions.at(-3),
        session2Id: ctx.exerciseSessions.at(-2),
        session3Id: ctx.exerciseSessions.at(-1),
      },
  },
  {
    name: 'report.session_results',
    args: (ctx) => ctx.latestSessionId && { sessionId: ctx.latestSessionId },
  },
  { name: 'report.weekly', args: () => ({}) },
  { name: 'accountability.state', args: () => ({}) },
  { name: 'accountability.preview', args: () => ({}) },
  { name: 'goal.list', args: () => ({}) },
];

/**
 * A tool's refusal with a domain code ("NO_PROGRAM_FOUND" on a store with no
 * program) is an answer, not a bug: the sweep lists it but does not count it. An
 * error with no code, or an internal one, is a finding.
 */
export function isDomainRefusal({ isError, text }) {
  if (!isError) return false;
  let code;
  try {
    code = JSON.parse(text)?.code;
  } catch {
    return false;
  }
  return typeof code === 'string' && /^[A-Z][A-Z_]+$/.test(code) && !/INTERNAL/.test(code);
}

/** The findings for one tool call: an unexplained error result, or bad tokens in its text. */
export function checkToolResult({ persona, tool, isError, text }) {
  const where = { persona, tool };
  const findings = findBadTokensInPayload(text).map((finding) => ({ ...finding, ...where }));
  if (isError && !isDomainRefusal({ isError, text })) {
    findings.push({ kind: 'tool-error', ...where, detail: text.slice(0, 300) });
  }
  return findings;
}

/** The findings for one captured page, in the order a reader wants them. */
export function checkPage({ persona, route, unit, text, expectedMonday }, table = EXPECTATIONS) {
  return [
    ...findBadTokens(text),
    ...(unit === 'kg' ? findLbLeaks(text) : []),
    ...findWeekOfMismatch(text, expectedMonday),
    ...checkPageExpectations({ persona, route, unit, text }, table),
  ];
}
