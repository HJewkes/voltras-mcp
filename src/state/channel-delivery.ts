// Channel-delivery confirmation tracker (VMCP-01.42 follow-up).
//
// `notifications/claude/channel` is fire-and-forget: the server cannot observe
// whether a push actually reached the model (no client capability, no ack — see
// server-tools.ts). The only reliable confirmation is the reply-tool pattern the
// Claude Code channels reference recommends: push a probe carrying a nonce, and
// have the model — which can only read that nonce if the `<channel>` tag was
// delivered inline — echo it back through a tool call.
//
// This tracker is the server-side ledger for that round-trip. `debug.push_test_channel`
// records the probe nonce; `debug.confirm_channel` records the model's echo and
// whether it matched the outstanding probe; `server.health` surfaces the last
// confirmed-delivery timestamp so an operator gets a persistent, in-band signal
// that channels are live rather than eyeballing whether a single probe landed.
//
// Process-local: a server restart resets the ledger (matching the debug ring
// buffers). The injected `nowIso` clock keeps the timestamps deterministic under
// test, mirroring the clock-injection pattern in rest-timer / mode-revert-guard.

export interface ChannelDeliverySnapshot {
  /** ISO timestamp of the last probe published via `debug.push_test_channel`, or null. */
  lastProbeAt: string | null;
  /** Nonce carried by the last probe, or null when none has fired. */
  lastProbeNonce: string | null;
  /** ISO timestamp of the last model-confirmed delivery, or null. */
  lastConfirmedAt: string | null;
  /** Nonce the model echoed on the last confirmation, or null. */
  lastConfirmedNonce: string | null;
  /**
   * Whether the last confirmation's nonce matched the outstanding probe nonce.
   * A match proves a genuine round-trip (the model could only know the nonce by
   * receiving the pushed `<channel>` tag). False when a confirmation arrives with
   * a stale / unknown nonce, or before any probe fired.
   */
  lastConfirmationMatchedProbe: boolean;
  /** Total confirmations recorded this process. */
  confirmations: number;
}

export class ChannelDeliveryTracker {
  private lastProbeAt: string | null = null;
  private lastProbeNonce: string | null = null;
  private lastConfirmedAt: string | null = null;
  private lastConfirmedNonce: string | null = null;
  private lastConfirmationMatchedProbe = false;
  private confirmations = 0;

  constructor(private readonly nowIso: () => string = () => new Date().toISOString()) {}

  /** Record that a probe carrying `nonce` was just published to the channel. */
  recordProbe(nonce: string): void {
    this.lastProbeNonce = nonce;
    this.lastProbeAt = this.nowIso();
  }

  /**
   * Record the model's echo of a received channel push. Returns the resulting
   * snapshot so the tool handler can report `matchedProbe` without a second read.
   */
  recordConfirmation(nonce: string): ChannelDeliverySnapshot {
    this.lastConfirmedNonce = nonce;
    this.lastConfirmedAt = this.nowIso();
    this.lastConfirmationMatchedProbe = nonce === this.lastProbeNonce;
    this.confirmations += 1;
    return this.snapshot();
  }

  snapshot(): ChannelDeliverySnapshot {
    return {
      lastProbeAt: this.lastProbeAt,
      lastProbeNonce: this.lastProbeNonce,
      lastConfirmedAt: this.lastConfirmedAt,
      lastConfirmedNonce: this.lastConfirmedNonce,
      lastConfirmationMatchedProbe: this.lastConfirmationMatchedProbe,
      confirmations: this.confirmations,
    };
  }
}
