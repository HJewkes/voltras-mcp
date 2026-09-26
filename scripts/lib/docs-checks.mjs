// Pure rules behind `npm run docs:check` (scripts/check-docs.mjs).
//
// The site's hard constraint is that every claim cites a file, a tool name or a
// PR that exists on `main`. A constraint nobody checks is a wish, so these are
// the mechanisable parts of it: a cited path resolves, a cited line is in
// range, a cited tool is registered, and no encoded device value appears on a
// page.
//
// FALSE POSITIVES are what get a guard deleted, so every extractor here is
// deliberately narrow and each exclusion says why. Nothing in this module
// touches the filesystem or git; the caller supplies what exists.

/** Extensions a citation may end in. An unknown one is prose, not a path. */
const CITED_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'json',
  'md',
  'yml',
  'yaml',
  'sh',
  'sql',
  'sqlite',
  'css',
  'html',
  'toml',
  'lock',
]);

/**
 * Build output and installed dependencies. Both are cited legitimately
 * (`dist/bin.js` is the thing a user runs) and neither exists in a clean
 * checkout, so their absence says nothing about the doc.
 */
const GENERATED_ROOTS = new Set(['dist', 'node_modules', 'coverage']);

/** A glob, a placeholder or a truncation: not a claim about one file. */
const NOT_A_LITERAL_PATH = /[*?<>{}…]/;

const URL_SHAPE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const PATH_SHAPE = /(?<![\w~./-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*)(?::(\d+(?:[-,]\d+)*))?/g;
const TOOL_SHAPE = /(?<![\w./-])[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]+)+(?![\w/*-])/g;

/** Lines of a document, with URLs blanked so their paths are not cited paths. */
function documentLines(text) {
  return text.split('\n').map((line) => line.replace(URL_SHAPE, ' '));
}

/** Markdown and sentence punctuation the path shape swallows at the end. */
function trimTrailingPunctuation(token) {
  return token.replace(/[.,:;_-]+$/, '');
}

/**
 * Path-shaped tokens with a repo-relative look: rooted at a real top-level
 * entry, and either a directory (trailing `/`) or a file with a known
 * extension. Everything else — `example.com/docs`, `v1.2/notes`, an exercise
 * name with a slash — is prose that happens to contain a slash.
 */
export function extractPathCitations(text, repoRoots) {
  const citations = [];
  for (const [index, line] of documentLines(text).entries()) {
    for (const match of line.matchAll(PATH_SHAPE)) {
      const raw = match[1];
      const isDirectory = raw.endsWith('/');
      const token = isDirectory ? raw : trimTrailingPunctuation(raw);
      if (NOT_A_LITERAL_PATH.test(token) || token === '') continue;
      // `src/**/*.test.ts` matches as far as `src/`; the glob starts where the
      // match stopped, and a glob is not a citation of its own first segment.
      if (NOT_A_LITERAL_PATH.test(line[match.index + match[0].length] ?? '')) continue;
      const [root] = token.split('/');
      if (!repoRoots.has(root) || GENERATED_ROOTS.has(root)) continue;
      const extension = token.split('/').at(-1).split('.').at(-1);
      if (!isDirectory && !CITED_EXTENSIONS.has(extension.toLowerCase())) continue;
      citations.push({ line: index + 1, path: token, lines: parseLineSpec(match[2]) });
    }
  }
  return citations;
}

/** `36` is one line, `5-6` is a range, and `28-45` plus `94` is a list — each reduces to the numbers it names. */
function parseLineSpec(spec) {
  if (spec === undefined) return [];
  return spec.split(/[-,]/).map(Number);
}

/**
 * Findings for path and line citations. `resolve` reports what the repo has:
 * `{ kind: 'file' | 'directory' | 'missing', lineCount }`.
 */
export function checkPathCitations(citations, resolve) {
  const findings = [];
  for (const citation of citations) {
    const target = resolve(citation.path);
    if (target.kind === 'missing') {
      findings.push({ ...citation, check: 'path', message: `no such file: ${citation.path}` });
      continue;
    }
    const cited = Math.max(0, ...citation.lines);
    if (target.kind !== 'file' || cited <= target.lineCount) continue;
    findings.push({
      ...citation,
      check: 'line',
      message: `${citation.path} has ${target.lineCount} lines; cited line ${cited}`,
    });
  }
  return findings;
}

/**
 * The exclusions check 3 needs, each standing for a real shape in these pages:
 *
 *   - a file name whose stem is a namespace — `server.ts`, `set.json`;
 *   - a truncation, from markdown eating the `*` in `system.lease_*`;
 *   - a PREFIX of a registered name, which is what markdown escaping leaves
 *     behind: `device.set*isokinetic*\*` reaches the reader as `device.set`;
 *   - a FIELD of a registered tool's output — `device.get_state.load_state`;
 *   - a SUFFIX of a registered name, which is how prose shortens inside a row
 *     that already named the namespace: `exercise.create` under `plan.*`.
 *
 * Each one weakens the check a little. They are the price of it surviving: a
 * guard that cries wolf on prose gets deleted, and then nothing is checked.
 */
function isExcludedToolToken(token, registry) {
  if (token.endsWith('_')) return true;
  if (CITED_EXTENSIONS.has(token.split('.').at(-1))) return true;
  for (const name of registry) {
    if (name.startsWith(`${token}.`) || name.startsWith(`${token}_`)) return true;
    if (token.startsWith(`${name}.`)) return true;
    if (name.endsWith(`.${token}`)) return true;
  }
  return false;
}

/**
 * Findings for `namespace.tool_name` tokens. Only namespaces the registry
 * actually has are judged: a dotted token in a namespace that does not exist
 * is somebody else's vocabulary, and guessing at it is how a guard earns its
 * reputation for noise. `known` carries dotted names that are not tools but
 * open with a tool namespace — the `metrics.compute` pipeline ids.
 */
export function checkToolNames(text, registry, known = new Set()) {
  const namespaces = new Set([...registry].map((name) => name.split('.')[0]));
  const findings = [];
  for (const [index, line] of documentLines(text).entries()) {
    for (const match of line.matchAll(TOOL_SHAPE)) {
      const token = match[0];
      if (!namespaces.has(token.split('.')[0])) continue;
      if (registry.has(token) || known.has(token)) continue;
      if (isExcludedToolToken(token, registry)) continue;
      findings.push({ line: index + 1, check: 'tool', message: `no such tool: ${token}` });
    }
  }
  return findings;
}

/**
 * The inverse of check 3, for the coach skill (VW-503): a registered tool the
 * skill never names is a tool the coach cannot reach. `ignored` carries the
 * reviewed exclusions — a name in it is a decision, not a threshold.
 *
 * The parser is the one check 3 uses, so the two halves agree about what
 * counts as naming a tool.
 */
export function checkToolCoverage(texts, registry, ignored) {
  const named = new Set();
  for (const text of texts) {
    for (const line of documentLines(text)) {
      for (const match of line.matchAll(TOOL_SHAPE)) named.add(match[0]);
    }
  }
  return [...registry]
    .filter((name) => !named.has(name) && !ignored.has(name))
    .map((name) => ({ check: 'coverage', message: `no page of the skill names ${name}` }));
}

/** The offset of `index` within `text`, as a 1-based line number. */
function lineOf(text, index) {
  let line = 1;
  for (let cursor = text.indexOf('\n'); cursor !== -1 && cursor < index; ) {
    line += 1;
    cursor = text.indexOf('\n', cursor + 1);
  }
  return line;
}

/**
 * Findings for encoded device values, using the shared guard in
 * `src/docs/protocol-guard.ts` — the same detector the generated capability
 * reference runs, so the two layers cannot disagree about what a value is.
 *
 * Never reports the token: a CI log is as public as the page it refused.
 * `allowed` holds reviewed exceptions as `path:token`.
 */
export function checkProtocolLeakage(text, { path, findEncodedValues, allowed }) {
  const findings = [];
  for (const match of findEncodedValues(text)) {
    if (allowed.has(`${path}:${match.token}`)) continue;
    findings.push({
      line: lineOf(text, match.start),
      check: 'protocol',
      message: `${match.kind} shaped token on a published page`,
    });
  }
  return findings;
}
