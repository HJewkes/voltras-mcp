// Persistent deviceId ↔ physical-side bindings (VMCP-02.05).
//
// The bilateral-Voltras side-ID ritual (set_mode Damper → ask user → revert →
// slot.swap if reversed) costs ~5 tool calls + 2 user questions on every new
// session. The deviceId ↔ side mapping is physically stable across sessions
// (the user does not move the units between workouts), so persisting the
// answer once eliminates the ritual on every subsequent session.
//
// ── Storage ───────────────────────────────────────────────────────────────
//
// File: `~/.voltras/slot-bindings.json` by default; overridable via
// `VMCP_SLOT_BINDINGS_PATH` for tests + non-default deploys. Sits next to the
// existing sqlite db so the per-user voltras data lives under one umbrella.
//
// Shape:
//   { version: 1, bindings: [{ deviceId, physicalSide, boundAt, lastSeen? }] }
//
// Writes are best-effort + synchronous. The dataset is tiny (≤ 2 entries
// today, ≤ a handful even if a user has multiple device pairs), so the
// simplest atomic write — tmpfile + rename — is both correct and cheap.
// A corrupt file is silently treated as empty so a malformed JSON on disk
// can never crash bootstrap or block a connect; the binding is rewritten on
// the next `slot_bind` call.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { log } from '../logger.js';

export type PhysicalSide = 'left' | 'right';

export interface SlotBinding {
  deviceId: string;
  physicalSide: PhysicalSide;
  /** ISO-8601 timestamp written when the binding was first established. */
  boundAt: string;
  /**
   * ISO-8601 timestamp of the most recent successful auto-assignment from
   * this binding. Helps debug stale entries without growing the schema.
   */
  lastSeen?: string;
}

interface BindingsFile {
  version: 1;
  bindings: SlotBinding[];
}

const CURRENT_VERSION = 1 as const;

/**
 * In-memory wrapper around the on-disk bindings. The constructor reads the
 * file once; subsequent calls use the cache and write through on mutation.
 * No file-watch — every MCP run boots fresh, and the cache invalidates
 * naturally on process restart.
 */
export class SlotBindingsStore {
  private bindings = new Map<string, SlotBinding>();

  private constructor(private readonly path: string) {}

  /**
   * Open the bindings file at `path`, reading the existing state into the
   * cache. A missing file is not an error — first-run users have no bindings
   * yet. A malformed file logs at `warn` and starts with an empty cache; the
   * next write will overwrite it cleanly.
   */
  static open(path: string): SlotBindingsStore {
    const store = new SlotBindingsStore(path);
    store.load();
    return store;
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err: unknown) {
      // ENOENT is the common path — first-run users have no file yet.
      const code = (err as { code?: string } | null)?.code;
      if (code === 'ENOENT') return;
      log.warn(`slot-bindings: read failed at ${this.path}; starting empty`, err);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn(`slot-bindings: invalid JSON at ${this.path}; starting empty`, err);
      return;
    }
    if (!isBindingsFile(parsed)) {
      log.warn(`slot-bindings: unexpected file shape at ${this.path}; starting empty`);
      return;
    }
    for (const b of parsed.bindings) {
      this.bindings.set(b.deviceId, { ...b });
    }
  }

  /**
   * Look up the persisted side for `deviceId`. Returns null when unbound.
   * Returns a defensive copy so a caller can't reach in and mutate the
   * cached entry (any update must go through `bind` / `touch` / `remove`
   * so the on-disk file stays in sync).
   */
  get(deviceId: string): SlotBinding | null {
    const found = this.bindings.get(deviceId);
    return found === undefined ? null : { ...found };
  }

  /**
   * Return a stable snapshot of every binding, sorted by deviceId so callers
   * can render a deterministic list (useful in test assertions + tool
   * responses). Each entry is a defensive copy — mutating the returned
   * array (or any entry within it) does not affect the store.
   */
  list(): SlotBinding[] {
    return [...this.bindings.values()]
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId))
      .map((b) => ({ ...b }));
  }

  /**
   * Establish or replace the binding for `deviceId`. Any existing binding
   * with the same deviceId is overwritten; bindings for the OTHER deviceId
   * on the same side are left alone (the caller decides whether a same-side
   * collision is a problem — the tool layer flags it as a warning, the
   * storage layer accepts it).
   */
  bind(deviceId: string, physicalSide: PhysicalSide): SlotBinding {
    const now = new Date(Date.now()).toISOString();
    const next: SlotBinding = { deviceId, physicalSide, boundAt: now, lastSeen: now };
    this.bindings.set(deviceId, next);
    this.persist();
    return next;
  }

  /**
   * Update the `lastSeen` field on an existing binding without resetting
   * `boundAt`. Called after a successful auto-assignment so a stale entry
   * surfaces in debug listings. No-op when the deviceId is unbound.
   */
  touch(deviceId: string): void {
    const existing = this.bindings.get(deviceId);
    if (!existing) return;
    existing.lastSeen = new Date(Date.now()).toISOString();
    this.persist();
  }

  /**
   * Remove the binding for `deviceId`. Returns the removed entry, or null
   * if no binding existed. Used by an explicit unbind tool (future work)
   * and by tests that need a clean slate.
   */
  remove(deviceId: string): SlotBinding | null {
    const existing = this.bindings.get(deviceId);
    if (!existing) return null;
    this.bindings.delete(deviceId);
    this.persist();
    return existing;
  }

  /** Drop every binding. Test-facing helper; no tool calls this directly. */
  clear(): void {
    this.bindings.clear();
    this.persist();
  }

  /**
   * Atomic write: serialise to a sibling tmpfile then rename over the live
   * path so a crash mid-write can't leave a half-written file behind. The
   * parent directory is created if missing (matches the SQLite open path's
   * implicit-mkdir behaviour at `~/.voltras/`).
   */
  private persist(): void {
    const payload: BindingsFile = {
      version: CURRENT_VERSION,
      bindings: this.list(),
    };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.path);
    } catch (err) {
      // Persistence failure is logged but not propagated — losing the
      // binding write means the next session re-runs the ritual, which is
      // a recoverable annoyance rather than a fatal error.
      log.warn(`slot-bindings: write failed at ${this.path}`, err);
    }
  }
}

function isBindingsFile(value: unknown): value is BindingsFile {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.version !== CURRENT_VERSION) return false;
  if (!Array.isArray(v.bindings)) return false;
  return v.bindings.every(isBinding);
}

function isBinding(value: unknown): value is SlotBinding {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.deviceId !== 'string' || v.deviceId.length === 0) return false;
  if (v.physicalSide !== 'left' && v.physicalSide !== 'right') return false;
  if (typeof v.boundAt !== 'string') return false;
  if (v.lastSeen !== undefined && typeof v.lastSeen !== 'string') return false;
  return true;
}
