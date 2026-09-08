// Every path this tool touches, resolved in one place.
//
// The outbox root mirrors the server's `VMCP_TRUECOACH_OUTBOX_DIR`, so a run
// that moves the server's outbox moves this tool's input with it. Nothing here
// is created eagerly; the writers create what they need, owner-only.

import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR_MODE = 0o700;

export function resolvePaths(env = process.env) {
  const home = env.HOME ?? homedir();
  const outbox = env.VMCP_TRUECOACH_OUTBOX_DIR ?? join(home, '.voltras', 'truecoach-outbox');
  return {
    outbox,
    pending: join(outbox, 'pending'),
    sent: join(outbox, 'sent'),
    screens: join(outbox, 'screens'),
    ledger: join(outbox, 'ledger.json'),
    profile: env.VMCP_TRUECOACH_PROFILE_DIR ?? join(home, '.voltras', 'truecoach-profile'),
  };
}

export { DIR_MODE };
