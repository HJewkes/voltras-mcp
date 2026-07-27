// Write-lease semantics (VMCP-01.61).
//
// The clock is injected, so every expiry case here is deterministic — no fake
// timers, no sleeps.

import { describe, it, expect } from 'vitest';
import { WriteLease, DEFAULT_LEASE_IDLE_MS } from '../write-lease.js';

/** Lease with a controllable clock and pin predicate. */
function makeLease(options: { idleTimeoutMs?: number } = {}): {
  lease: WriteLease;
  advance: (ms: number) => void;
  setPinned: (value: boolean) => void;
} {
  let clock = 1_000_000;
  let pinned = false;
  const lease = new WriteLease({
    now: () => clock,
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_LEASE_IDLE_MS,
    isPinned: () => pinned,
  });
  return {
    lease,
    advance: (ms) => {
      clock += ms;
    },
    setPinned: (value) => {
      pinned = value;
    },
  };
}

describe('acquiring', () => {
  it('grants a free lease', () => {
    const { lease } = makeLease();
    const decision = lease.tryAcquire('a');
    expect(decision.ok).toBe(true);
    expect(lease.status()?.clientId).toBe('a');
  });

  it('is a no-op refresh for the current holder', () => {
    const { lease, advance } = makeLease();
    lease.tryAcquire('a');
    const acquiredAt = lease.status()!.acquiredAt;

    advance(5_000);
    const again = lease.tryAcquire('a');

    expect(again.ok).toBe(true);
    // Still the same tenure — a refresh must not look like a re-acquisition.
    expect(lease.status()!.acquiredAt).toBe(acquiredAt);
    expect(lease.status()!.lastActivityAt).toBe(acquiredAt + 5_000);
  });

  it('denies a second client and names the holder', () => {
    const { lease } = makeLease();
    lease.tryAcquire('a');

    const decision = lease.tryAcquire('b');

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.holder.clientId).toBe('a');
    expect(lease.isHeldBy('a')).toBe(true);
    expect(lease.isHeldBy('b')).toBe(false);
  });

  it('reports whether a set is in progress when denying', () => {
    const { lease, setPinned } = makeLease();
    lease.tryAcquire('a');

    expect(lease.tryAcquire('b')).toMatchObject({ ok: false, pinned: false });
    setPinned(true);
    expect(lease.tryAcquire('b')).toMatchObject({ ok: false, pinned: true });
  });
});

describe('idle expiry', () => {
  it('lets another client take over once the holder goes idle', () => {
    const { lease, advance } = makeLease({ idleTimeoutMs: 1_000 });
    lease.tryAcquire('a');

    advance(999);
    expect(lease.tryAcquire('b').ok).toBe(false);

    advance(2);
    expect(lease.tryAcquire('b').ok).toBe(true);
    expect(lease.status()?.clientId).toBe('b');
  });

  it('defers expiry when the holder keeps working', () => {
    // Activity deferral happens in tryAcquire's holder-refresh branch — that is
    // the path every WRITE tool call takes, so it is the one that can regress.
    const { lease, advance } = makeLease({ idleTimeoutMs: 1_000 });
    lease.tryAcquire('a');

    advance(900);
    lease.tryAcquire('a');
    advance(900);

    expect(lease.tryAcquire('b').ok).toBe(false);
    expect(lease.isHeldBy('a')).toBe(true);
  });

  it('is not kept alive by a non-holder trying to acquire', () => {
    const { lease, advance } = makeLease({ idleTimeoutMs: 1_000 });
    lease.tryAcquire('a');

    advance(900);
    lease.tryAcquire('b');
    advance(200);

    // 'b' failing to acquire must not refresh 'a', so 'a' has aged out.
    expect(lease.tryAcquire('b').ok).toBe(true);
  });

  it('NEVER expires while a set is in progress', () => {
    // The safety-relevant case: a lifter mid-set is not idle just because the
    // model has issued no tool call. If this regresses, another session can
    // take the device out from under someone under load.
    const { lease, advance, setPinned } = makeLease({ idleTimeoutMs: 1_000 });
    lease.tryAcquire('a');
    setPinned(true);

    advance(60 * 60 * 1000);

    expect(lease.tryAcquire('b').ok).toBe(false);
    expect(lease.isHeldBy('a')).toBe(true);
    expect(lease.status()?.clientId).toBe('a');
  });

  it('expires once the pinning set ends', () => {
    const { lease, advance, setPinned } = makeLease({ idleTimeoutMs: 1_000 });
    lease.tryAcquire('a');
    setPinned(true);
    advance(60_000);
    setPinned(false);

    expect(lease.tryAcquire('b').ok).toBe(true);
  });
});

describe('stealing', () => {
  it('transfers from an active holder and reports it', () => {
    const { lease } = makeLease();
    lease.tryAcquire('a');

    const stolen = lease.steal('b');

    expect(stolen.stolen).toBe(true);
    expect(lease.isHeldBy('b')).toBe(true);
  });

  it('is not a steal when the lease was free', () => {
    const { lease } = makeLease();
    expect(lease.steal('b').stolen).toBe(false);
  });

  it('is not a steal from yourself', () => {
    const { lease } = makeLease();
    lease.tryAcquire('a');
    expect(lease.steal('a').stolen).toBe(false);
  });

  it('takes the lease even while a set is pinned', () => {
    // The lease class cannot enforce the safety unload — lease-tools.ts owns
    // that ordering. This asserts the class does not silently refuse instead,
    // which would make a forced takeover fail open.
    const { lease, setPinned } = makeLease();
    lease.tryAcquire('a');
    setPinned(true);

    expect(lease.steal('b').stolen).toBe(true);
    expect(lease.isHeldBy('b')).toBe(true);
  });
});

describe('releasing', () => {
  it('frees the lease for the holder', () => {
    const { lease } = makeLease();
    lease.tryAcquire('a');

    expect(lease.release('a')).toBe(true);
    expect(lease.status()).toBeNull();
    expect(lease.tryAcquire('b').ok).toBe(true);
  });

  it('is a no-op for a non-holder', () => {
    const { lease } = makeLease();
    lease.tryAcquire('a');

    expect(lease.release('b')).toBe(false);
    expect(lease.isHeldBy('a')).toBe(true);
  });

  it('drops the lease on disconnect even mid-set', () => {
    // Nobody is driving the device any more, so the pin must not strand it.
    const { lease, setPinned } = makeLease();
    lease.tryAcquire('a');
    setPinned(true);

    expect(lease.releaseOnDisconnect('a')).toBe(true);
    expect(lease.status()).toBeNull();
  });
});

describe('status', () => {
  it('returns null when free', () => {
    expect(makeLease().lease.status()).toBeNull();
  });

  it('reports how long the holder has held it, off the injected clock', () => {
    const { lease, advance } = makeLease();
    lease.tryAcquire('a');
    advance(4_000);

    const denied = lease.tryAcquire('b');

    expect(denied.ok).toBe(false);
    expect(denied.ok === false && denied.heldForMs).toBe(4_000);
  });

  it('peek() does NOT expire an idle holder, status() does', () => {
    // read-classified tools go through peek, whose contract is to touch no
    // shared mutable state. If peek expired, an observer's polling would decide
    // when the holder record vanishes.
    const { lease, advance } = makeLease({ idleTimeoutMs: 1_000 });
    lease.tryAcquire('a');
    advance(2_000);

    expect(lease.peek()?.clientId).toBe('a');
    expect(lease.status()).toBeNull();
    expect(lease.peek()).toBeNull();
  });

  it('hands back a copy, not the live holder record', () => {
    const { lease } = makeLease();
    lease.tryAcquire('a');

    const snapshot = lease.status()!;
    snapshot.clientId = 'tampered';

    expect(lease.status()!.clientId).toBe('a');
  });
});
