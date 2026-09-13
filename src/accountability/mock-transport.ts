// In-memory `CoachTransport` (VW-286, child row 2).
//
// Exists so the protocol machine is testable end to end with no Apple ID, no
// second macOS user and no BlueBubbles server. It records what it was asked to
// send and can be armed to fail, which is the only way to exercise the
// error-handling side of a channel that publishes no delivery signal.

import {
  CoachMessageRejectedError,
  CoachTransportUnavailableError,
  type CoachTransport,
} from './transport.js';

export interface RecordedMessage {
  handle: string;
  text: string;
  at: Date;
}

export class MockCoachTransport implements CoachTransport {
  readonly sent: RecordedMessage[] = [];
  private failure: 'unavailable' | 'rejected' | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Make every subsequent `send` throw, until `recover()`. */
  failWith(kind: 'unavailable' | 'rejected'): void {
    this.failure = kind;
  }

  recover(): void {
    this.failure = null;
  }

  send(handle: string, text: string): Promise<void> {
    if (this.failure === 'unavailable') {
      return Promise.reject(
        new CoachTransportUnavailableError('mock transport is armed to be unavailable'),
      );
    }
    if (this.failure === 'rejected') {
      return Promise.reject(new CoachMessageRejectedError('mock transport rejected the message'));
    }
    this.sent.push({ handle, text, at: this.now() });
    return Promise.resolve();
  }
}
