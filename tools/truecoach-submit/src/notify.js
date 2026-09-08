// Getting a human's attention when an unattended run hits a login wall.
//
// Best effort by design: the notification is how the human learns, but a
// notification that fails must not mask the error that triggered it. Every
// failure here is swallowed and the message still goes to stderr.

import { execFileSync } from 'node:child_process';

const TIMEOUT_MS = 10_000;

export function notifyHuman(message, run = execFileSync) {
  console.error(`truecoach-submit: ${message}`);
  if (tryAgentChat(message, run)) return 'agent-chat';
  return tryOsascript(message, run) ? 'osascript' : 'stderr';
}

/**
 * `agent-chat ask` is the preferred channel, but the installed CLI does not
 * always carry that subcommand — probe before using it rather than treating a
 * present binary as a present command.
 */
function tryAgentChat(message, run) {
  try {
    const help = run('agent-chat', ['ask', '--help'], { timeout: TIMEOUT_MS, encoding: 'utf8' });
    if (String(help).includes('unknown command')) return false;
    run('agent-chat', ['ask', message], { timeout: TIMEOUT_MS, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function tryOsascript(message, run) {
  try {
    const script = `display notification ${quote(message)} with title "truecoach-submit"`;
    run('osascript', ['-e', script], { timeout: TIMEOUT_MS, encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function quote(text) {
  return `"${text.replace(/["\\]/g, '\\$&')}"`;
}
