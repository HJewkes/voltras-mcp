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
//   - channelsEnabled  — the `claude/channel` push surface is live (see below).
//   - channelsDegraded — pushes are expected but silently falling back to
//                       polling because the host didn't opt in (see below).
//
// Resolution and version reads happen at module load time; the per-call
// handler just composes the output. This keeps `server.health` cheap and
// removes any disk I/O from the request path. The channel flags are the one
// per-call computation — they read the live client capabilities, which only
// exist after `initialize` completes.

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
 * those pushes actually reach the model depends on the host opting in at launch
 * (the dev-channels flag), which the host signals back as a client capability.
 * The two flags below let an agent tell — deterministically, in-band — whether
 * to expect pushes or must fall back to polling. Without this, a host launched
 * without the flag degrades to polling with no other signal (VMCP-02.30 / Bug
 * #4): tools that publish channel events silently never wake the model.
 */
interface ChannelStatus {
  /**
   * The push surface is live: a real publisher is wired AND the connected host
   * declared the `claude/channel` client capability. Channel events reach the
   * model inline; no polling needed.
   */
  channelsEnabled: boolean;
  /**
   * The server intends to push (a real publisher is wired) but the host did
   * NOT opt in, so every published event is silently dropped and the agent
   * must poll to observe state changes. This is the silent-degradation case.
   * Mutually exclusive with `channelsEnabled`; both are false when no real
   * publisher is wired (e.g. tests), since nothing was expected to push.
   */
  channelsDegraded: boolean;
}

/** True when the connected host opted into `claude/channel` push delivery. */
function hostAcceptsChannels(state: ServerState): boolean {
  const capabilities = state.server?.server.getClientCapabilities();
  return capabilities?.experimental?.['claude/channel'] !== undefined;
}

/**
 * Derive the channel push-surface status from the wired publisher and the
 * host's declared capabilities. A real (non-noop) publisher means the server
 * intends to push; the host capability decides whether that push is delivered.
 */
function resolveChannelStatus(state: ServerState): ChannelStatus {
  const publisherWired = state.channels !== undefined && state.channels !== noopChannelPublisher;
  const hostOptedIn = hostAcceptsChannels(state);
  return {
    channelsEnabled: publisherWired && hostOptedIn,
    channelsDegraded: publisherWired && !hostOptedIn,
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
