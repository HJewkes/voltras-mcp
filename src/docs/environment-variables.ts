// The environment variables the server reads, as the published reference lists
// them (VMCP-07.08). The code is the source of truth: `src/config.ts` for most,
// and the module named in `source` for the few read elsewhere. A docs test
// scans `src/` for every `VMCP_*` / `VOLTRA*` read and fails when this list and
// the code disagree in either direction.
//
// Types and defaults only for anything that touches the device session: the
// capture variables name a path, never what a capture holds.

export type OnInvalid = 'stops startup' | 'uses the default' | 'not checked';

export interface EnvironmentVariable {
  readonly name: string;
  readonly section: string;
  readonly defaultValue: string;
  readonly accepts: string;
  readonly onInvalid: OnInvalid;
  readonly purpose: string;
  /** The file that reads the variable. */
  readonly source: string;
}

const CONFIG = 'src/config.ts';
const ON_OFF = '`off` \\| `on`';

export const ENVIRONMENT_VARIABLES: readonly EnvironmentVariable[] = [
  {
    name: 'VOLTRA_ADAPTER',
    section: 'Core',
    defaultValue: '`node`',
    accepts: '`node` \\| `mock`',
    onInvalid: 'stops startup',
    purpose:
      'Which device adapter to use. `mock` runs an in-process simulated device and adds the `mock.*` tools.',
    source: CONFIG,
  },
  {
    name: 'VMCP_DB_PATH',
    section: 'Core',
    defaultValue: '`~/.voltras/vmcp.sqlite`',
    accepts: 'file path',
    onInvalid: 'not checked',
    purpose:
      'The SQLite store for sessions, sets and plans. Give each server that runs at the same time its own path.',
    source: CONFIG,
  },
  {
    name: 'VMCP_SLOT_BINDINGS_PATH',
    section: 'Core',
    defaultValue: '`~/.voltras/slot-bindings.json`',
    accepts: 'file path',
    onInvalid: 'not checked',
    purpose: 'Where the saved left and right device bindings of the `slot.*` tools live.',
    source: CONFIG,
  },
  {
    name: 'VMCP_LOG_LEVEL',
    section: 'Core',
    defaultValue: '`info`',
    accepts: '`debug` \\| `info` \\| `warn` \\| `error`',
    onInvalid: 'not checked',
    purpose: 'Log verbosity. Logs go to stderr, because stdout carries the MCP transport.',
    source: CONFIG,
  },
  {
    name: 'VMCP_MOUNT_RATING_LBS',
    section: 'Core',
    defaultValue: '_unset_',
    accepts: 'positive number',
    onInvalid: 'stops startup',
    purpose:
      'The load rating of the anchor mount, in pounds. Isometric and eccentric-overload peaks above it are refused; unset means unknown, not unlimited, and those tools warn.',
    source: CONFIG,
  },
  {
    name: 'VMCP_DASHBOARD_PORT',
    section: 'Dashboard and voice',
    defaultValue: '`7723`',
    accepts: 'port number \\| `off` \\| `0`',
    onInvalid: 'uses the default',
    purpose:
      'Port of the local dashboard. `off` or `0` turns it off. A busy port falls back to one the OS picks, so read the URL from `server.health`.',
    source: 'src/server.ts',
  },
  {
    name: 'VMCP_CUES',
    section: 'Dashboard and voice',
    defaultValue: '`off`',
    accepts: ON_OFF,
    onInvalid: 'stops startup',
    purpose:
      'Spoken coaching cues at set boundaries, macOS only. A startup default: `system.set_cues` changes it at runtime.',
    source: CONFIG,
  },
  {
    name: 'VMCP_CUES_MIDSET',
    section: 'Dashboard and voice',
    defaultValue: '`off`',
    accepts: '`off` \\| `on` \\| `risk`',
    onInvalid: 'stops startup',
    purpose:
      'Lets the cues that fire while the lifter is under load speak too. `risk` allows them only through the cue-delivery layer (`VMCP_CUE_DELIVERY=on`), and only on a set whose set-risk reading is green; amber and red sets, and sets with no reading, stay silent mid-set. A set whose earlier set of the same exercise was recorded by an older server version reads its fatigue as unknown, so under `risk` it stays silent mid-set too. A startup default: `system.set_cues` changes it at runtime.',
    source: CONFIG,
  },
  {
    name: 'VMCP_CUE_DELIVERY',
    section: 'Dashboard and voice',
    defaultValue: '`off`',
    accepts: ON_OFF,
    onInvalid: 'stops startup',
    purpose:
      'Speaks the automatic cues through the cue-delivery layer instead: a per-set budget by training tier, one repeated technique focus, and a firmer tone as the set nears failure. Replaces the default cues rather than adding to them, and the two cue switches still gate it.',
    source: CONFIG,
  },
  {
    name: 'VOLTRAS_EFFORT_CUE',
    section: 'Dashboard and voice',
    defaultValue: '`off`',
    accepts: ON_OFF,
    onInvalid: 'stops startup',
    purpose:
      'Lets the effort rule choose the one mid-set ending cue and store a cue record with the set. Off until it is validated on a device.',
    source: CONFIG,
  },
  {
    name: 'VOLTRAS_VAD_MODEL',
    section: 'Dashboard and voice',
    defaultValue: 'the bundled model',
    accepts: 'file path',
    onInvalid: 'uses the default',
    purpose:
      'Replaces the voice-activity model that `system.listen_start` uses. A path that does not exist is ignored.',
    source: 'src/voice/vad.ts',
  },
  {
    name: 'VMCP_AUTO_ARM',
    section: 'Recording',
    defaultValue: '`on`',
    accepts: ON_OFF,
    onInvalid: 'stops startup',
    purpose:
      'Reps during an open session with no open set open a set and count into it. `off` reports those reps as idle reps only.',
    source: CONFIG,
  },
  {
    name: 'VMCP_REST_TIMER',
    section: 'Recording',
    defaultValue: '`off`',
    accepts: ON_OFF,
    onInvalid: 'stops startup',
    purpose:
      'Starts the rest-status push cycle when a set closes on its own. Never started when `session.end` closes the set.',
    source: CONFIG,
  },
  {
    name: 'VMCP_REP_SOURCE',
    section: 'Recording',
    defaultValue: '`analytics`',
    accepts: '`analytics` \\| `firmware`',
    onInvalid: 'stops startup',
    purpose:
      'Which rep pipeline reads draw from. `firmware` is not yet validated on a device; see the [roadmap](/roadmap).',
    source: CONFIG,
  },
  {
    name: 'VMCP_REP_UNRACK_DROP',
    section: 'Recording',
    defaultValue: '`off`',
    accepts: ON_OFF,
    onInvalid: 'stops startup',
    purpose:
      'Drops the un-rack artifact rep when a set closes. Off until validated across movement types, because it changes the stored rep count.',
    source: CONFIG,
  },
  {
    name: 'VMCP_REP_ECC_TRUNCATE',
    section: 'Recording',
    defaultValue: '`on`',
    accepts: ON_OFF,
    onInvalid: 'stops startup',
    purpose:
      "Trims the idle tail off the last rep's lowering phase when a set closes. It deletes no rep.",
    source: CONFIG,
  },
  {
    name: 'VMCP_REP_CORRECTIONS',
    section: 'Recording',
    defaultValue: '_unset_',
    accepts: ON_OFF,
    onInvalid: 'stops startup',
    purpose:
      'Legacy switch that sets the two variables above together. Either one set on its own wins over it.',
    source: CONFIG,
  },
  {
    name: 'VMCP_DEBUG_BUFFER_SIZE',
    section: 'Diagnostics',
    defaultValue: '`256`',
    accepts: 'positive integer',
    onInvalid: 'uses the default',
    purpose:
      'Capacity of the in-memory buffer behind `debug.recent_frames` and `debug.recent_events`.',
    source: 'src/state/debug-buffer.ts',
  },
  {
    name: 'VMCP_RECORD_SESSION',
    section: 'Diagnostics',
    defaultValue: '_unset_',
    accepts: '`1` \\| `true`',
    onInvalid: 'not checked',
    purpose:
      'Turns on a local capture of the device session for offline replay. `debug.recording_status` reports it.',
    source: 'src/state/session-recorder.ts',
  },
  {
    name: 'VMCP_CAPTURE_DIR',
    section: 'Diagnostics',
    defaultValue: '`~/.voltras/captures`',
    accepts: 'directory path',
    onInvalid: 'not checked',
    purpose: 'Where the session capture is written. Keep it outside any repository.',
    source: 'src/state/session-recorder.ts',
  },
  {
    name: 'VMCP_TRUECOACH_USERNAME',
    section: 'TrueCoach',
    defaultValue: '_unset_',
    accepts: 'email',
    onInvalid: 'not checked',
    purpose: 'TrueCoach account email for `truecoach.import_week`.',
    source: CONFIG,
  },
  {
    name: 'VMCP_TRUECOACH_PASSWORD',
    section: 'TrueCoach',
    defaultValue: '_unset_',
    accepts: 'string',
    onInvalid: 'not checked',
    purpose: 'TrueCoach password, in plaintext. Prefer `VMCP_TRUECOACH_PASSWORD_CMD`.',
    source: CONFIG,
  },
  {
    name: 'VMCP_TRUECOACH_PASSWORD_CMD',
    section: 'TrueCoach',
    defaultValue: '_unset_',
    accepts: 'shell command',
    onInvalid: 'not checked',
    purpose:
      'A command that prints the password, so the secret can stay in the macOS keychain. Wins over `VMCP_TRUECOACH_PASSWORD`.',
    source: CONFIG,
  },
  {
    name: 'VMCP_TRUECOACH_CLIENT_ID',
    section: 'TrueCoach',
    defaultValue: 'the id from the sign-in response',
    accepts: 'string',
    onInvalid: 'not checked',
    purpose: 'Overrides the TrueCoach client id the pull reads.',
    source: CONFIG,
  },
  {
    name: 'VMCP_TRUECOACH_TOKEN_PATH',
    section: 'TrueCoach',
    defaultValue: '`~/.voltras/truecoach-token.json`',
    accepts: 'file path',
    onInvalid: 'not checked',
    purpose: 'Cached access token, readable by the owner only.',
    source: CONFIG,
  },
  {
    name: 'VMCP_TRUECOACH_CACHE_DIR',
    section: 'TrueCoach',
    defaultValue: '`~/.voltras/truecoach-cache`',
    accepts: 'directory path',
    onInvalid: 'not checked',
    purpose: 'Cache of raw TrueCoach responses.',
    source: CONFIG,
  },
  {
    name: 'VMCP_TRUECOACH_OUTBOX',
    section: 'TrueCoach',
    defaultValue: '`off`',
    accepts: ON_OFF,
    onInvalid: 'stops startup',
    purpose:
      "`session.end` writes the session's coach results to a local outbox file. Nothing is uploaded.",
    source: CONFIG,
  },
  {
    name: 'VMCP_TRUECOACH_OUTBOX_DIR',
    section: 'TrueCoach',
    defaultValue: '`~/.voltras/truecoach-outbox`',
    accepts: 'directory path',
    onInvalid: 'not checked',
    purpose: 'Root directory of the outbox.',
    source: CONFIG,
  },
  {
    name: 'VMCP_TRUECOACH_SUBMIT_ON_END',
    section: 'TrueCoach',
    defaultValue: '`off`',
    accepts: ON_OFF,
    onInvalid: 'stops startup',
    purpose:
      'With the outbox on, each written entry also starts one unattended submit to TrueCoach. Read the README section on TrueCoach write-back first.',
    source: CONFIG,
  },
];
