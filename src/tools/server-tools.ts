// `server.*` diagnostic tools.
//
// The single tool here, `server.health`, is the "is the right build / SDK /
// adapter actually running" check. It returns:
//   - version       — voltras-mcp's package.json version (read once at module
//                     load).
//   - build         — best-effort short git SHA of the running tree (`unknown`
//                     when git is unavailable or the cwd isn't a repo).
//   - adapter       — `state.config.adapter` ('node' | 'mock').
//   - sdkVersion    — version field from the *resolved* @voltras/node-sdk
//                     package.json so a tarball install reports its real
//                     version, not whatever the parent's package.json says.
//   - analyticsVersion — same trick for @voltras/workout-analytics.
//   - dbPath        — `state.config.dbPath`.
//   - logLevel      — `state.config.logLevel`.
//   - channelsWired — a real (non-noop) `claude/channel` publisher is
//                     installed, so the server IS emitting channel
//                     notifications (see below).
//   - channelsLastConfirmedAt — ISO timestamp of the last model-confirmed
//                     channel delivery (reply-tool round-trip), or null.
//
// Resolution and version reads happen at module load time; the per-call
// handler just composes the output. This keeps `server.health` cheap and
// removes any disk I/O from the request path. `channelsWired` is the one
// per-call computation — it reads the currently-wired publisher off state.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ServerHealthInput } from '../schemas/server.js';
import { noopChannelPublisher } from '../state/channel-publisher.js';
import type { ServerState } from '../state/server-state.js';
import { wrapHandler } from './helpers.js';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

interface PackageJsonShape {
  version?: string;
}

const require = createRequire(import.meta.url);

/**
 * Walk up from `start` to find the nearest package.json containing a `name`
 * matching `expectedName`. Used to anchor voltras-mcp's own version read at
 * the right manifest (the resolved SDK / analytics manifests are located
 * separately via `require.resolve`).
 */
function readVoltrasMcpVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // Walk up: dist/tools/server-tools.js -> dist/tools -> dist -> repo root
    let dir = dirname(here);
    for (let i = 0; i < 6; i += 1) {
      const candidate = join(dir, 'package.json');
      try {
        const body = readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(body) as PackageJsonShape & { name?: string };
        if (parsed.name === 'voltras-mcp' && typeof parsed.version === 'string') {
          return parsed.version;
        }
      } catch {
        // not a package.json here — keep walking
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return 'unknown';
}

/**
 * Resolve a dependency's package.json via `require.resolve(<pkg>/package.json)`
 * and return its `version` field. Reflects the actual installed version even
 * for tarball / file: installs whose declared range in voltras-mcp's
 * package.json may not match what's on disk.
 */
function readResolvedDependencyVersion(pkg: string): string {
  try {
    const manifestPath = require.resolve(`${pkg}/package.json`);
    const body = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(body) as PackageJsonShape;
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Best-effort current git short SHA. Returns 'unknown' on any failure (cwd
 * not a repo, git binary missing, detached state, etc.) so the tool never
 * surfaces a noisy error for what is purely informational output.
 */
function readGitShortSha(): string {
  try {
    const out = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    if (out.length === 0) return 'unknown';
    return out;
  } catch {
    return 'unknown';
  }
}

// Resolved once at module load; subsequent server.health calls reuse these.
const VMCP_VERSION = readVoltrasMcpVersion();
const SDK_VERSION = readResolvedDependencyVersion('@voltras/node-sdk');
const ANALYTICS_VERSION = readResolvedDependencyVersion('@voltras/workout-analytics');
const BUILD_SHA = readGitShortSha();

/**
 * Reported state of the `claude/channel` push surface.
 *
 * `runServer` always declares the server-side `claude/channel` capability and
 * installs a real publisher, so the server always *intends* to push. Whether
 * those pushes actually reach the model depends on the host being launched with
 * `--dangerously-load-development-channels`, but — critically — that opt-in is
 * a host-internal routing decision that is INVISIBLE to the server: Claude Code
 * declares no matching client capability, and `notifications/claude/channel` is
 * fire-and-forget with no ack (events drop silently when channels aren't loaded).
 * See https://code.claude.com/docs/en/channels-reference.
 *
 * So the server can only truthfully report whether it is *emitting* events, not
 * whether they are *delivered*. `channelsWired` reports exactly that. Actual
 * end-to-end delivery is confirmed via the reply-tool round-trip: push a probe
 * with `debug.push_test_channel` and echo its nonce back with
 * `debug.confirm_channel`. `channelsLastConfirmedAt` surfaces the timestamp of
 * the most recent such confirmation, giving a persistent in-band signal that
 * channels are live (VMCP-01.42 corrects the earlier VMCP-02.30 flags, which
 * read a client capability the host never sends and so always reported
 * `channelsDegraded` even while pushes were live).
 */
interface ChannelStatus {
  /**
   * A real (non-noop) publisher is installed, so the server IS emitting
   * `claude/channel` notifications. This is server-knowable and honest; it is
   * NOT a delivery guarantee (see above). False when no real publisher is
   * wired (e.g. tests), since nothing is being pushed.
   */
  channelsWired: boolean;
  /**
   * ISO timestamp of the most recent model-confirmed channel delivery (via the
   * `debug.push_test_channel` → `debug.confirm_channel` round-trip), or null
   * when no delivery has been confirmed this process. Unlike `channelsWired`,
   * a non-null value here is positive proof the host is routing pushes to the
   * model — the only reliable delivery signal available server-side.
   */
  channelsLastConfirmedAt: string | null;
}

/**
 * Report the channel push surface. A real (non-noop) publisher means the server
 * is actively emitting events; delivery to the model is not directly observable,
 * so `channelsLastConfirmedAt` reflects the last reply-tool confirmation instead.
 */
function resolveChannelStatus(state: ServerState): ChannelStatus {
  const publisherWired = state.channels !== undefined && state.channels !== noopChannelPublisher;
  return {
    channelsWired: publisherWired,
    channelsLastConfirmedAt: state.channelDelivery?.snapshot().lastConfirmedAt ?? null,
  };
}

/**
 * Hot-swap the `server.health` placeholder with the real handler. Mirrors
 * the install pattern used by the device/session/set tool registries.
 */
export function registerServerTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  const tool = placeholders.get('server.health');
  if (tool === undefined) {
    throw new Error('tool placeholder not registered: server.health');
  }
  tool.update({
    paramsSchema: ServerHealthInput.shape,
    callback: wrapHandler(ServerHealthInput, () =>
      Promise.resolve({
        version: VMCP_VERSION,
        build: BUILD_SHA,
        adapter: state.config.adapter,
        sdkVersion: SDK_VERSION,
        analyticsVersion: ANALYTICS_VERSION,
        dbPath: state.config.dbPath,
        logLevel: state.config.logLevel,
        ...resolveChannelStatus(state),
      }),
    ) as never,
  });
}
