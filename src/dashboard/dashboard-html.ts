// HTML page served at GET / by the dashboard sidecar.
//
// Single-file, inline CSS + vanilla JS — no build step, no framework.
// The page polls /api/snapshot every 500 ms and /api/health once on load.
// Rest timer ticks every 1 s via its own setInterval, independent of the
// poll loop so the display stays smooth even when the poll is slow.
//
// Layout: two-column above 700 px (current-set left, rest-timer right),
// single-column below 700 px.

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Voltras MCP Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0f1117;
      --surface: #1a1d27;
      --surface-alt: #21253a;
      --border: #2d3150;
      --text: #e2e8f0;
      --text-muted: #64748b;
      --accent: #6366f1;
      --green: #22c55e;
      --orange: #f97316;
      --red: #ef4444;
      --yellow: #eab308;
      --status-ok: var(--green);
      --status-stale: var(--orange);
      --status-error: var(--red);
      --poll-ms: 500;
      font-family: ui-monospace, 'Cascadia Code', 'SF Mono', Consolas, monospace;
    }

    body {
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 20px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    header h1 {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--accent);
      flex: 1;
    }

    #status {
      font-size: 18px;
      line-height: 1;
      color: var(--text-muted);
      transition: color 0.3s;
    }
    #status.ok    { color: var(--status-ok); }
    #status.stale { color: var(--status-stale); }
    #status.error { color: var(--status-error); }

    #last-update {
      font-size: 11px;
      color: var(--text-muted);
      min-width: 80px;
      text-align: right;
    }

    main {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding: 16px;
      align-items: start;
    }

    @media (max-width: 700px) {
      main { grid-template-columns: 1fr; }
    }

    section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }

    section h2 {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 14px;
    }

    /* Key-value rows */
    .kv {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 5px 0;
      border-bottom: 1px solid var(--border);
      gap: 8px;
    }
    .kv:last-of-type { border-bottom: none; }
    .kv > span:first-child {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
    }
    .kv > span:last-child {
      font-size: 14px;
      font-weight: 600;
      text-align: right;
    }

    /* Empty-state text */
    .empty {
      font-size: 12px;
      color: var(--text-muted);
      text-align: center;
      padding: 20px 0;
    }

    /* Per-rep velocity bar chart */
    #rep-bars {
      margin-top: 14px;
    }
    #rep-bars-title {
      font-size: 10px;
      color: var(--text-muted);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .rep-bar-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 5px;
    }
    .rep-bar-label {
      font-size: 10px;
      color: var(--text-muted);
      width: 24px;
      text-align: right;
      flex-shrink: 0;
    }
    .rep-bar-track {
      flex: 1;
      background: var(--surface-alt);
      border-radius: 3px;
      height: 14px;
      overflow: hidden;
    }
    .rep-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.2s ease;
      min-width: 2px;
    }
    .rep-bar-val {
      font-size: 10px;
      color: var(--text-muted);
      width: 52px;
      flex-shrink: 0;
    }

    /* Rest timer */
    #rest-timer-display {
      font-size: 52px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text);
      margin: 16px 0 6px;
      text-align: center;
    }
    #rest-timer-display.na {
      font-size: 32px;
      color: var(--text-muted);
    }
    #rest-timer-since {
      font-size: 11px;
      color: var(--text-muted);
      text-align: center;
    }
  </style>
</head>
<body>
  <header>
    <h1>Voltras MCP</h1>
    <div id="status">&#9679;</div>
    <div id="last-update">—</div>
  </header>

  <main>
    <section id="current-set">
      <h2>Current set</h2>
      <div id="current-set-empty" class="empty">No active set</div>
      <div id="current-set-active" hidden>
        <div class="kv"><span>Weight</span><span id="cs-weight">—</span></div>
        <div class="kv"><span>Mode</span><span id="cs-mode">—</span></div>
        <div class="kv"><span>Reps</span><span id="cs-reps">0</span></div>
        <div class="kv"><span>Latest peak velocity</span><span id="cs-peak-vel">—</span></div>
        <div class="kv"><span>Target weight</span><span id="cs-target">—</span></div>
        <div id="rep-bars" hidden>
          <div id="rep-bars-title">Peak velocity per rep (cm/s)</div>
          <div id="rep-bars-list"></div>
        </div>
      </div>
    </section>

    <section id="rest-timer">
      <h2>Rest timer</h2>
      <div id="rest-timer-display" class="na">—</div>
      <div id="rest-timer-since">since last set ended</div>
    </section>
  </main>

  <script>
    'use strict';

    // ── Constants ────────────────────────────────────────────────────────────
    const POLL_MS = 500;
    const STALE_THRESHOLD_MS = POLL_MS * 2;

    // ── Element refs ─────────────────────────────────────────────────────────
    const elStatus      = document.getElementById('status');
    const elLastUpdate  = document.getElementById('last-update');
    const elCsEmpty     = document.getElementById('current-set-empty');
    const elCsActive    = document.getElementById('current-set-active');
    const elCsWeight    = document.getElementById('cs-weight');
    const elCsMode      = document.getElementById('cs-mode');
    const elCsReps      = document.getElementById('cs-reps');
    const elCsPeakVel   = document.getElementById('cs-peak-vel');
    const elCsTarget    = document.getElementById('cs-target');
    const elRepBars     = document.getElementById('rep-bars');
    const elRepBarsList = document.getElementById('rep-bars-list');
    const elRestDisplay = document.getElementById('rest-timer-display');
    const elRestSince   = document.getElementById('rest-timer-since');

    // ── State ────────────────────────────────────────────────────────────────
    /** Unix-ms when the last successful poll rendered. */
    let lastSuccessMs = 0;
    /** Unix-ms when the rest period began (last set ended). */
    let restStartMs = null;
    /** Whether there was an active set at the previous poll tick. */
    let prevSetActive = false;

    // ── Helpers ──────────────────────────────────────────────────────────────
    function fmtVelocity(cmPerSec) {
      if (cmPerSec == null) return '—';
      return cmPerSec.toFixed(1) + ' cm/s';
    }

    function fmtWeight(lbs) {
      if (lbs == null) return '—';
      return lbs.toFixed(1) + ' lbs';
    }

    function fmtMode(mode) {
      if (mode == null) return '—';
      // Convert camelCase / PascalCase to spaced words
      return mode.replace(/([A-Z])/g, ' $1').trim();
    }

    /** Format elapsed seconds as M:SS */
    function fmtElapsed(ms) {
      const totalSec = Math.floor(ms / 1000);
      const min  = Math.floor(totalSec / 60);
      const sec  = totalSec % 60;
      return min + ':' + String(sec).padStart(2, '0');
    }

    /** Return a CSS colour string based on relative magnitude 0..1 */
    function barColor(ratio) {
      // Interpolate from orange (low) to green (high) via yellow
      if (ratio > 0.75) return '#22c55e';   // green
      if (ratio > 0.5)  return '#84cc16';   // lime
      if (ratio > 0.25) return '#eab308';   // yellow
      return '#f97316';                      // orange
    }

    // ── Status indicator ─────────────────────────────────────────────────────
    function setStatus(state) {
      elStatus.className = state; // 'ok' | 'stale' | 'error'
    }

    function updateLastUpdate() {
      const now = new Date();
      elLastUpdate.textContent =
        now.getHours().toString().padStart(2, '0') + ':' +
        now.getMinutes().toString().padStart(2, '0') + ':' +
        now.getSeconds().toString().padStart(2, '0');
    }

    // ── Current-set panel ────────────────────────────────────────────────────
    function renderCurrentSet(snapshot) {
      const activeSet = snapshot && snapshot.sets && snapshot.sets.active;
      const device    = snapshot && snapshot.devices && snapshot.devices[0] && snapshot.devices[0].device;

      if (!activeSet) {
        elCsEmpty.hidden  = false;
        elCsActive.hidden = true;
        return;
      }

      elCsEmpty.hidden  = true;
      elCsActive.hidden = false;

      // Weight: prefer device.weightLbs; fall back to latestInProgress target
      const weightLbs = device && device.weightLbs != null
        ? device.weightLbs
        : (activeSet.latestInProgress && activeSet.latestInProgress.targetWeightTenths != null
            ? activeSet.latestInProgress.targetWeightTenths / 10
            : null);
      elCsWeight.textContent = fmtWeight(weightLbs);

      // Mode
      const mode = device && device.trainingMode != null ? device.trainingMode : null;
      elCsMode.textContent = fmtMode(mode);

      // Reps
      const reps = Array.isArray(activeSet.reps) ? activeSet.reps : [];
      elCsReps.textContent = reps.length;

      // Peak velocity of latest rep
      const latestRep = reps.length > 0 ? reps[reps.length - 1] : null;
      const latestPeak = latestRep && latestRep.concentric
        ? latestRep.concentric.peakVelocity
        : null;
      elCsPeakVel.textContent = fmtVelocity(latestPeak);

      // Target weight from latestInProgress
      const targetTenths = activeSet.latestInProgress
        ? activeSet.latestInProgress.targetWeightTenths
        : null;
      elCsTarget.textContent = targetTenths != null
        ? fmtWeight(targetTenths / 10)
        : '—';

      // Per-rep bar chart
      renderRepBars(reps);
    }

    function renderRepBars(reps) {
      if (!reps || reps.length === 0) {
        elRepBars.hidden = true;
        elRepBarsList.innerHTML = '';
        return;
      }

      // Find the max peak velocity in the set for normalisation
      let maxVel = 0;
      for (const rep of reps) {
        const v = rep && rep.concentric ? rep.concentric.peakVelocity : 0;
        if (v > maxVel) maxVel = v;
      }

      const rows = reps.map((rep) => {
        const vel   = rep && rep.concentric ? rep.concentric.peakVelocity : 0;
        const ratio = maxVel > 0 ? vel / maxVel : 0;
        const pct   = (ratio * 100).toFixed(1);
        const color = barColor(ratio);
        const label = rep ? rep.repNumber : '?';
        return (
          '<div class="rep-bar-row">' +
            '<span class="rep-bar-label">' + label + '</span>' +
            '<div class="rep-bar-track">' +
              '<div class="rep-bar-fill" style="width:' + pct + '%;background:' + color + '"></div>' +
            '</div>' +
            '<span class="rep-bar-val">' + (vel != null ? vel.toFixed(1) : '—') + ' cm/s</span>' +
          '</div>'
        );
      });

      elRepBarsList.innerHTML = rows.join('');
      elRepBars.hidden = false;
    }

    // ── Rest-timer panel ─────────────────────────────────────────────────────
    function updateRestTimer() {
      if (restStartMs === null) {
        elRestDisplay.textContent = '—';
        elRestDisplay.className   = 'na';
        elRestSince.textContent   = 'since last set ended';
        return;
      }
      const elapsed = Date.now() - restStartMs;
      elRestDisplay.textContent = fmtElapsed(elapsed);
      elRestDisplay.className   = '';
    }

    // Called by the poll loop to detect set-end transitions.
    function updateRestState(snapshot) {
      const activeSet   = snapshot && snapshot.sets && snapshot.sets.active;
      const setIsActive = !!activeSet;

      // Transition: had active set → now no active set → rest started
      if (prevSetActive && !setIsActive) {
        restStartMs = Date.now();
      }
      // Transition: rest started → new set started → clear rest
      if (!prevSetActive && setIsActive && restStartMs !== null) {
        restStartMs = null;
      }

      prevSetActive = setIsActive;
      updateRestTimer();
    }

    // ── Poll loop ─────────────────────────────────────────────────────────────
    async function pollSnapshot() {
      try {
        const response = await fetch('/api/snapshot');
        if (!response.ok) {
          setStatus('error');
          return;
        }
        const snapshot = await response.json();
        lastSuccessMs = Date.now();
        setStatus('ok');
        updateLastUpdate();
        renderCurrentSet(snapshot);
        updateRestState(snapshot);
      } catch (_err) {
        setStatus('error');
      }
    }

    // ── Staleness watchdog ───────────────────────────────────────────────────
    // Runs every second (same interval as the rest timer).
    function checkStaleness() {
      if (lastSuccessMs > 0 && Date.now() - lastSuccessMs > STALE_THRESHOLD_MS) {
        setStatus('stale');
      }
      updateRestTimer();
    }

    // ── Boot ──────────────────────────────────────────────────────────────────
    // Health check on load — surface any startup error early.
    fetch('/api/health').catch(() => setStatus('error'));

    // Primary poll loop
    setInterval(pollSnapshot, POLL_MS);
    pollSnapshot();

    // Rest-timer tick + staleness watchdog (1 s)
    setInterval(checkStaleness, 1000);
  </script>
</body>
</html>
`;
