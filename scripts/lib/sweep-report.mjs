// The contact sheet `npm run sweep` writes beside its PNGs: one row per persona,
// one column per route x viewport x unit, a red or green border per cell with
// that cell's findings under it, and two filters (red only, changed since the
// last run). Pure: it renders from the run record `persona-sweep.mjs` also
// writes to findings.json.

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** The column a cell belongs to, also its PNG's file stem within a persona. */
export function columnKey({ route, viewport, unit }) {
  const page = route.replace(/^#\/?/, '').replaceAll('/', '-') || 'live';
  return `${page}-${viewport}-${unit}`;
}

function findingList(findings) {
  if (findings.length === 0) return '';
  const items = findings.map((f) => `<li>${escapeHtml(`${f.kind}: ${f.detail}`)}</li>`);
  return `<ul>${items.join('')}</ul>`;
}

function cellHtml(cell) {
  if (cell === undefined) return '<td class="missing">not captured</td>';
  const state = cell.findings.length === 0 ? 'green' : 'red';
  const classes = [state, cell.changed ? 'changed' : ''].join(' ').trim();
  const changed = cell.changed ? `<p class="delta">changed: ${escapeHtml(cell.changed)}</p>` : '';
  const shot = cell.png
    ? `<a href="${escapeHtml(cell.png)}"><img loading="lazy" src="${escapeHtml(cell.png)}"></a>`
    : '<p>no screenshot</p>';
  return `<td class="${classes}">${shot}${changed}${findingList(cell.findings)}</td>`;
}

function personaRow(persona, columns, cells, apiFindings) {
  const byColumn = new Map(cells.map((cell) => [columnKey(cell), cell]));
  const apiState = apiFindings.length === 0 ? 'green' : 'red';
  return (
    `<tr><th>${escapeHtml(persona)}</th>` +
    `<td class="api ${apiState}">${findingList(apiFindings) || 'endpoints and tools clean'}</td>` +
    columns.map((column) => cellHtml(byColumn.get(column))).join('') +
    '</tr>'
  );
}

const STYLE = `
body { font: 13px system-ui, sans-serif; margin: 16px; }
table { border-collapse: separate; border-spacing: 6px; }
th { text-align: left; vertical-align: top; white-space: nowrap; }
td { vertical-align: top; width: 180px; border: 4px solid transparent; padding: 4px; }
td.green { border-color: #2e9d4f; } td.red { border-color: #d13a3a; }
td.missing { border-color: #999; color: #666; }
td img { width: 170px; display: block; }
td ul { margin: 4px 0 0; padding-left: 16px; max-height: 160px; overflow: auto; }
.delta { color: #8a5a00; margin: 2px 0; }
body.only-red td.green:not(.api), body.only-changed td:not(.changed):not(.api) { opacity: 0.08; }
`;

const FILTER_SCRIPT = `
for (const id of ['only-red', 'only-changed']) {
  document.getElementById(id).addEventListener('change', (e) => {
    document.body.classList.toggle(id, e.target.checked);
  });
}`;

/** The whole contact sheet for one run record. */
export function renderContactSheet(run) {
  const columns = run.columns;
  const header = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
  const rows = run.personas.map((persona) =>
    personaRow(
      persona,
      columns,
      run.cells.filter((cell) => cell.persona === persona),
      run.apiFindings.filter((finding) => finding.persona === persona),
    ),
  );
  const red = run.cells.filter((cell) => cell.findings.length > 0).length;
  const changed = run.cells.filter((cell) => cell.changed).length;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Persona sweep ${escapeHtml(run.run)}</title>
<style>${STYLE}</style></head>
<body>
<h1>Persona sweep ${escapeHtml(run.run)}</h1>
<p>Seeded at ${escapeHtml(run.seedNow)}, viewed at ${escapeHtml(run.viewNow)} (${escapeHtml(run.timeZone)}).
${run.cells.length} cells, ${red} red, ${changed} changed since ${escapeHtml(run.previousRun ?? 'no earlier run')}.</p>
<label><input type="checkbox" id="only-red"> red only</label>
<label><input type="checkbox" id="only-changed"> changed since last run</label>
<table><thead><tr><th>persona</th><th>endpoints and tools</th>${header}</tr></thead>
<tbody>${rows.join('\n')}</tbody></table>
<script>${FILTER_SCRIPT}</script>
</body></html>
`;
}
