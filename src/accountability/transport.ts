// The coach's outbound message door (VW-286, child row 1).
//
// One method, because that is the whole of what the channel offers us: no
// delivery receipt, no read receipt, no typing indicator. Those need
// BlueBubbles' Private API helper bundle, which requires disabling SIP on this
// laptop, and we are not doing that. So `send` resolving means "handed to the
// transport", never "the lifter saw it", and nothing downstream may branch on
// delivery.
//
// No implementation of this interface talks to a network in this module. The
// BlueBubbles implementation lands with VW-237's server; until then the only
// implementation is `MockCoachTransport`.

/** Base class for every failure a transport is allowed to raise. */
export class CoachTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = 'CoachTransportError';
  }
}

/** The transport itself is not reachable — server down, user switched out, laptop asleep. */
export class CoachTransportUnavailableError extends CoachTransportError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('TRANSPORT_UNAVAILABLE', message, options);
    this.name = 'CoachTransportUnavailableError';
  }
}

/** The transport is reachable but refused this message — unknown handle, no chat, bad credential. */
export class CoachMessageRejectedError extends CoachTransportError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('MESSAGE_REJECTED', message, options);
    this.name = 'CoachMessageRejectedError';
  }
}

export interface CoachTransport {
  /**
   * Hand one message to the channel. Resolving means accepted for delivery.
   *
   * Throws `CoachTransportUnavailableError` when the channel cannot be reached
   * and `CoachMessageRejectedError` when it refuses the message.
   */
  send(handle: string, text: string): Promise<void>;
}
