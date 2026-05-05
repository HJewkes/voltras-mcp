// claude/channel publisher — pushes notifications into the live conversation
// when the host (Claude Code) is launched with channels enabled.
//
// Why claude/channel: `notifications/resource_updated` is delivered to the
// host but NOT routed back into the live conversation in Claude Code — it's
// used as a cache hint only, so the model never sees the change without
// polling. `claude/channel` IS delivered inline as `<channel>` tags whose
// `meta` keys become XML attributes on the tag, so the model wakes up on
// state changes without any polling tool. See:
//   https://code.claude.com/docs/en/channels
//   https://code.claude.com/docs/en/channels-reference
//
// Capability declaration is the experimental key on `ServerCapabilities`
// (see `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts:573`):
//   capabilities: { experimental: { 'claude/channel': {} } }
//
// Delivery semantics: channels are opt-in at session launch — the user must
// pass `--channels` for the notification to be routed to the model. When the
// host doesn't enable them the notification is silently dropped server-side.
// The publisher therefore fire-and-forgets the underlying promise, matching
// the same `void server.server.sendResourceUpdated(...)` pattern used in the
// event-bridge for resource updates.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface ChannelEvent {
  /** Human-readable line shown to the model inside the <channel> tag body. */
  content: string;
  /** Key/value pairs serialized as XML attributes on the <channel> tag. */
  meta: Record<string, string>;
}

export interface ChannelPublisher {
  publish(event: ChannelEvent): void;
}

/**
 * Publishes claude/channel notifications via the underlying MCP Server.
 * Fire-and-forget: the host (Claude Code) silently drops notifications when
 * channels aren't enabled at session launch (--channels flag), so a failure
 * here is not actionable. Matches the same void-discard pattern used for
 * sendResourceUpdated in event-bridge.ts.
 */
export class McpChannelPublisher implements ChannelPublisher {
  constructor(private readonly server: McpServer) {}

  publish(event: ChannelEvent): void {
    void this.server.server.notification({
      method: 'notifications/claude/channel',
      params: { content: event.content, meta: event.meta },
    });
  }
}
