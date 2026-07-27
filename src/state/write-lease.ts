// The device write-lease (VMCP-01.61).
//
// Exactly one client may drive the device at a time. Everyone else keeps every
// READ tool — see `TOOL_ACCESS` in `tool-registry.ts` — so an observer session
// can watch a live set, read history, and check server health without holding
// anything.
//
// GRANULARITY: one lease covers the whole device, not one per slot. Bilateral
// cascade drives both slots together, and noble imposes a process-wide BLE
// write mutex that the passive scanner already respects
// (`server-state.ts`, `passiveScan`), so per-slot leasing would be a
// granularity the hardware does not actually have.
//
// This class is pure: no timers, no I/O, an injected clock. Expiry is
// evaluated lazily on each call rather than driven by a `setInterval`, which
// keeps it deterministic under test and means a lease can never expire between
// the check and the use.
//
// With a single stdio client — today's only shape — the first WRITE call
// acquires and nothing ever contends, so behaviour is unchanged.

import type { ClientId } from '../client-connection.js';

/**
 * How long a holder may sit idle before another client may take the lease
 * without forcing.
 *
 * An active set PINS the lease (see `isPinned`), so this governs only
 * "connected, holding, doing nothing". It therefore has to outlast a long rest
 * period plus model thinking time — hence minutes, not seconds. Fifteen is a
 * first pick, not a measured one; VW-68 tracks it as an open question.
 */
export const DEFAULT_LEASE_IDLE_MS = 15 * 60 * 1000;

export interface LeaseHolder {
  clientId: ClientId;
  /** Epoch ms at which this client took the lease. */
  acquiredAt: number;
  /** Epoch ms of the holder's most recent WRITE call. */
  lastActivityAt: number;
}

/** Granted: the caller now holds the lease. */
export interface LeaseGranted {
  ok: true;
  holder: LeaseHolder;
  /** True when the grant took the lease from a different client. */
  stolen: boolean;
}

/** Denied: someone else holds it, and is not idle enough to displace. */
export interface LeaseDenied {
  ok: false;
  holder: LeaseHolder;
  /** True when the device is engaged — a steal must surrender it first. */
  pinned: boolean;
  /** How long the holder has held it, off the injected clock (testable). */
  heldForMs: number;
}

export type LeaseDecision = LeaseGranted | LeaseDenied;

export interface WriteLeaseOptions {
  /** Injected clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Idle window before a holder can be displaced without forcing. */
  idleTimeoutMs?: number;
  /**
   * Whether a set is currently in progress. The lease asks rather than being
   * told, so it cannot drift out of sync with the real set lifecycle: there is
   * no `set.start` hook to forget to call, and a set that ends by device
   * (rather than by `set.end`) unpins automatically.
   */
  isPinned?: () => boolean;
}

export class WriteLease {
  private holder: LeaseHolder | null = null;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly isPinned: () => boolean;

  constructor(options: WriteLeaseOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_LEASE_IDLE_MS;
    this.isPinned = options.isPinned ?? ((): boolean => false);
  }

  /**
   * Current holder, or `null` when free. Expires an idle holder first, so this
   * is a MUTATING read — use {@link peek} from anything classified `read`.
   */
  status(): LeaseHolder | null {
    this.expireIfIdle();
    return this.holder === null ? null : { ...this.holder };
  }

  /**
   * Current holder without expiring an idle one.
   *
   * `server.health` and `system.lease_status` are classified `read`, whose
   * contract is "touches no shared mutable state". Routing them through
   * `status()` would let an observer's polling decide WHEN a holder record
   * disappears. The answers differ only for a holder already past the idle
   * timeout, which the next `tryAcquire` expires anyway.
   */
  peek(): LeaseHolder | null {
    return this.holder === null ? null : { ...this.holder };
  }

  /** Whether `clientId` currently holds the lease. */
  isHeldBy(clientId: ClientId): boolean {
    this.expireIfIdle();
    return this.holder?.clientId === clientId;
  }

  /**
   * Take the lease for `clientId`, or report who is in the way.
   *
   * Granted when the lease is free, already held by this client (a no-op
   * refresh), or held by a client that has been idle past the timeout without
   * a set in progress. Never grants by displacing an active holder — that is
   * {@link steal}, which the caller must safety-unload before.
   */
  tryAcquire(clientId: ClientId): LeaseDecision {
    this.expireIfIdle();
    if (this.holder === null) {
      return { ok: true, holder: this.grant(clientId), stolen: false };
    }
    if (this.holder.clientId === clientId) {
      this.holder.lastActivityAt = this.now();
      return { ok: true, holder: { ...this.holder }, stolen: false };
    }
    return {
      ok: false,
      holder: { ...this.holder },
      pinned: this.isPinned(),
      heldForMs: this.now() - this.holder.acquiredAt,
    };
  }

  /**
   * Transfer the lease to `clientId` regardless of the current holder.
   *
   * SAFETY: when a set is in progress the caller MUST unload the device before
   * calling this. Handing motor control to another session mid-rep, with a
   * person attached to the cable, is a physical hazard rather than a
   * data-consistency one — this class cannot enforce that, so
   * `lease-tools.ts` owns the ordering.
   */
  steal(clientId: ClientId): LeaseGranted {
    const previous = this.holder;
    return {
      ok: true,
      holder: this.grant(clientId),
      stolen: previous !== null && previous.clientId !== clientId,
    };
  }

  /**
   * Release the lease if `clientId` holds it. Returns whether it did.
   * A non-holder calling this is a no-op, not an error — releasing something
   * you do not hold is already the state you asked for.
   */
  release(clientId: ClientId): boolean {
    if (this.holder?.clientId !== clientId) return false;
    this.holder = null;
    return true;
  }

  /**
   * Drop the lease because a client went away (socket close / stdio EOF).
   *
   * Mechanically identical to {@link release} — the distinction is at the CALL
   * SITE, not here: `system.lease_release` surrenders an engaged device before
   * releasing, whereas the disconnect path in `ClientConnection.close` has to
   * surrender it too but cannot ask the departed client's permission.
   */
  releaseOnDisconnect(clientId: ClientId): boolean {
    return this.release(clientId);
  }

  private grant(clientId: ClientId): LeaseHolder {
    const at = this.now();
    this.holder = { clientId, acquiredAt: at, lastActivityAt: at };
    return { ...this.holder };
  }

  /**
   * Drop an idle holder so the lease is takeable again. A set in progress pins
   * the lease unconditionally — a lifter mid-set is not "idle" just because
   * the model has not issued a tool call recently.
   */
  private expireIfIdle(): void {
    if (this.holder === null) return;
    if (this.isPinned()) return;
    if (this.now() - this.holder.lastActivityAt < this.idleTimeoutMs) return;
    this.holder = null;
  }
}
