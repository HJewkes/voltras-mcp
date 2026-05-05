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
  /**
   * Return a publisher that auto-injects `slot: slotId` into every event's
   * meta. Step 4 of P0 dual-Voltras support — bilateral coaching surfaces
   * need every channel event tagged with the originating slot so they can
   * tell left-arm rep events from right-arm ones. Single-device flows go
   * through the primary slot, so existing pipelines see `slot: 'primary'`
   * (a meta-key addition, not a behavior change). The returned publisher
   * preserves the underlying transport: forSlot() on a no-op publisher is
   * still a no-op.
   */
  forSlot(slotId: string): ChannelPublisher;
}

/**
 * Build a slot-scoped publisher around an existing one. The wrapper passes
 * every publish through to `inner`, but spreads `slot: slotId` into the meta
 * first so explicit `slot` keys on the event still win (defensive — no caller
 * should set `slot` directly, but the merge order means a hand-set value
 * overrides the slot-scope tag rather than silently colliding).
 */
function slotScopedPublisher(inner: ChannelPublisher, slotId: string): ChannelPublisher {
  return {
    publish(event: ChannelEvent): void {
      inner.publish({
        content: event.content,
        meta: { slot: slotId, ...event.meta },
      });
    },
    forSlot(nextSlotId: string): ChannelPublisher {
      // Re-scoping a slot publisher rebases on the underlying transport so
      // chained `.forSlot('a').forSlot('b')` lands on `slot: 'b'`. Without
      // this rebase the merge above would let the outer slot win (`{slot: 'a',
      // ...{slot: 'b'}}` = 'b' — fine in this direction, but the explicit
      // rebase keeps the contract obvious).
      return slotScopedPublisher(inner, nextSlotId);
    },
  };
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

  forSlot(slotId: string): ChannelPublisher {
    return slotScopedPublisher(this, slotId);
  }
}

/**
 * No-op publisher used when channels aren't wired (tests, hosts launched
 * without --channels). Provides a `forSlot` that returns the same no-op so
 * slot-scoped publish callers never have to special-case the channel
 * transport.
 */
export const noopChannelPublisher: ChannelPublisher = {
  publish: () => undefined,
  forSlot: () => noopChannelPublisher,
};
