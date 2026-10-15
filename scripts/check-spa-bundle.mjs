#!/usr/bin/env node
// check-spa-bundle: prove the fidelity overlay is absent from a production SPA bundle (VW-431).
//
// Usage:
//   node scripts/check-spa-bundle.mjs --absent dist/spa    # fails if any sentinel appears
//   node scripts/check-spa-bundle.mjs --present <outDir>   # fails if any sentinel is missing
//
// `--present` runs against a fidelity build so the `--absent` grep cannot pass vacuously, for
// example after a minifier change or a renamed handle.

import * as fs from 'node:fs';
import * as path from 'node:path';

// `__vmcpFidelity` is the registry's window handle; the attribute prefix is the provenance wrapper's markers.
const SENTINELS = ['__vmcpFidelity', 'data-vmcp-fidelity-'];

function usage(message) {
  console.error(`check-spa-bundle: ${message}`);
  console.error('usage: node scripts/check-spa-bundle.mjs --absent|--present <dir>');
  process.exit(2);
}

function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function findSentinels(dir) {
  const hits = new Map(SENTINELS.map((sentinel) => [sentinel, []]));
  for (const file of listFiles(dir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const sentinel of SENTINELS) {
      if (text.includes(sentinel)) hits.get(sentinel).push(path.relative(dir, file));
    }
  }
  return hits;
}

const [mode, dir] = process.argv.slice(2);
if (mode !== '--absent' && mode !== '--present') usage(`unknown mode ${mode ?? '(none)'}`);
if (!dir || !fs.existsSync(path.join(dir, 'index.html')))
  usage(`no built SPA at ${dir ?? '(none)'}`);

const hits = findSentinels(dir);
const failures = SENTINELS.filter((sentinel) =>
  mode === '--absent' ? hits.get(sentinel).length > 0 : hits.get(sentinel).length === 0,
);
for (const sentinel of SENTINELS) {
  const files = hits.get(sentinel);
  console.log(`${sentinel}: ${files.length === 0 ? 'not found' : `found in ${files.join(', ')}`}`);
}
if (failures.length > 0) {
  const verb =
    mode === '--absent' ? 'present in a production bundle' : 'missing from a fidelity bundle';
  console.error(`check-spa-bundle: FAIL, ${failures.join(' and ')} ${verb} (${dir})`);
  process.exit(1);
}
console.log(
  `check-spa-bundle: OK, ${mode === '--absent' ? 'no' : 'every'} fidelity sentinel in ${dir}`,
);
