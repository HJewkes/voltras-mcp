// VW-195 guard: every channel event kind the server can publish carries an
// emit-time `meta.at`, scoped or not. There is no runtime kind registry, so the
// kinds are derived from the `event_type: '<kind>'` literals in non-test source.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { McpChannelPublisher } = await import('../channel-publisher.js');

const SRC_DIR = join(__dirname, '..', '..');
const FIXED_NOW = '2026-09-29T08:30:00.000Z';
const TRANSPORT_METHOD = 'notifications/claude/channel';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const FILES = sourceFiles(SRC_DIR).map((path) => ({
  path: relative(SRC_DIR, path),
  text: readFileSync(path, 'utf8'),
}));

const EVENT_KINDS = [
  ...new Set(
    FILES.flatMap((f) => [...f.text.matchAll(/event_type: '([a-z_]+)'/g)].map((m) => m[1]!)),
  ),
].sort();

function publishedMeta(publish: (p: InstanceType<typeof McpChannelPublisher>) => void) {
  const notification = vi.fn(() => Promise.resolve());
  const publisher = new McpChannelPublisher(
    { server: { notification } } as unknown as ConstructorParameters<typeof McpChannelPublisher>[0],
    () => FIXED_NOW,
  );
  publish(publisher);
  expect(notification).toHaveBeenCalledTimes(1);
  const [message] = notification.mock.calls[0] as unknown as [
    { params: { meta: Record<string, string> } },
  ];
  return message.params.meta;
}

describe('every channel event kind carries meta.at (VW-195)', () => {
  it('finds the event kinds to walk', () => {
    expect(EVENT_KINDS).toContain('rep_finalized');
    expect(EVENT_KINDS).toContain('timer_complete');
    expect(EVENT_KINDS.length).toBeGreaterThan(20);
  });

  it.each(EVENT_KINDS)('%s: unscoped publish is stamped with the injected time', (kind) => {
    const meta = publishedMeta((p) => p.publish({ content: kind, meta: { event_type: kind } }));

    expect(meta.at).toBe(FIXED_NOW);
    expect(meta.event_type).toBe(kind);
  });

  it.each(EVENT_KINDS)('%s: slot-scoped publish is stamped with the injected time', (kind) => {
    const meta = publishedMeta((p) =>
      p
        .forSlot('left')
        .forSlot('right')
        .publish({ content: kind, meta: { event_type: kind } }),
    );

    expect(meta.at).toBe(FIXED_NOW);
    expect(meta.slot).toBe('right');
  });

  it('reaches the transport only through McpChannelPublisher', () => {
    const emitters = FILES.filter((f) => f.text.includes(`'${TRANSPORT_METHOD}'`)).map(
      (f) => f.path,
    );

    expect(emitters).toEqual(['state/channel-publisher.ts']);
  });
});
