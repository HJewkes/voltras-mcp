# Agent transcript exporter (VW-257)

`scripts/export-agent-transcript.mjs` records an agent exchange against the real MCP server
on the mock adapter and writes a redacted transcript. A video renderer turns that transcript
into an animated chat pane, so the pane shows real tool calls and real channel pushes
without anyone typing them by hand.

```sh
npm run build
node scripts/export-agent-transcript.mjs --exchange <exchange.json> --out <transcript.json>
```

## What goes in: an exchange script

An exchange script is authored JSON. Its schema is `exchangeScriptSchema` in
[`src/docs/agent-transcript.ts`](../src/docs/agent-transcript.ts). Each step is one of:

- `{ "user": "..." }` or `{ "assistant": "..." }`: authored text, at most 280 characters.
- `{ "call": "<tool>", "args": {...} }`: a real `tools/call`. `showArgs` and `showResult`
  name the args and flat result fields the pane may show. `offscreen: true` runs the call
  but writes no entry. The arg value `"$scan.firstDeviceId"` stands for the first device
  the most recent `device.scan` returned.
- `{ "awaitChannel": "<event_type>", "count": N }`: wait up to 15 s for the next N pushes
  of that type. `showFields` names the push meta keys the pane may show.

`pinnedReps` sets the rep burst the mock device runs after each `set.start`. The device is
parked after `device.connect` and moves only during a burst
([`scripts/lib/mock-burst.mjs`](../scripts/lib/mock-burst.mjs)), so two exports of the same
exchange are byte-identical. The exporter lets each burst finish before the next step runs,
so a `set.end` never cuts a rep short. As on hardware, a rep's push fires when the next rep
begins, so the last rep's push arrives with `set.end`. Without `pinnedReps` the device stays
parked and no reps arrive.

The repository carries one synthetic exchange, used by the integration test:
[`src/__tests__/fixtures/connect-and-set.exchange.json`](../src/__tests__/fixtures/connect-and-set.exchange.json).
Exchanges for the video live with the video, because their wording is storyboard copy.

## What comes out: the transcript

A `voltras-agent-transcript/1` document: ordered entries of kind `user`, `assistant`,
`tool_call`, `tool_result` and `channel`. There are no timestamps, latencies, or session,
set or request ids, so `seq` is the only ordering.

## Why nothing private can reach the file

Every value passes the fail-closed gates in `src/docs/agent-transcript.ts`: a tool
allowlist by namespace, projection of args onto the tool's public input schema, result and
push fields only when the exchange names them, a key denylist, and value checks. A shown
value may not hold a hex run, a UUID, a base64 run, a date or a filesystem path, even when
the exchange names it. Authored user and assistant text is not held to the date and path
checks. The finished transcript is then walked once more. Any refusal exits 1 and writes no file.

The exporter adds its own limits:

- It runs only on the mock adapter. It refuses when `VOLTRA_ADAPTER` names any other
  adapter, and it checks that `server.health` reports `mock` before running a step.
- It refuses `device.send_raw` and the `debug.*`, `mock.*`, `system.*` and `truecoach.*`
  namespaces by name before the server boots. It never calls `debug.recent_events`.
- The server gets an environment built from scratch: `HOME`, the store, the slot bindings
  and the capture directory all point into a temporary directory that is deleted
  afterwards. No real store is opened. The dashboard, auto-arm, rest timer and spoken cues
  are off.
- Raw responses and pushes stay in memory. A push contributes only its event type, its slot
  and the meta keys the exchange names. Its content body is never read.

The integration test
([`src/__tests__/integration/agent-transcript-export.test.ts`](../src/__tests__/integration/agent-transcript-export.test.ts))
exports the synthetic exchange twice and asserts schema validity, the structural walk and
byte-identical output. One of the two runs gets a parent env whose home, store, bindings
and capture settings all point into a sentinel directory, which must stay empty. The test
also asserts that a `device.send_raw` step, a `debug.recent_events` step and a non-mock
adapter are each refused with no file written. A `debug.not_a_tool` step must be refused as
`TOOL_REFUSED` too. That tool is in no `tools/list`, so only the refusal made before the
server boots can name it that way.
