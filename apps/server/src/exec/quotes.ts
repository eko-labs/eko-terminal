import { randomBytes } from 'node:crypto';
import type { Quote } from '@eko/shared';

interface Stored {
  quote: Quote;
  accountId: string;
  consumed: boolean;
}

/** Short-lived in-memory quote cache. Quotes are single-use and expire on their own clock. */
export class QuoteStore {
  private quotes = new Map<string, Stored>();
  /**
   * Retain clock and start an unref'ed 30-second cache cleanup timer. Host-only construction; quotes
   * older than expiry plus five minutes are removed, while execution callers enforce actual expiry.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  constructor(private now: () => number = Date.now) {
    setInterval(() => this.gc(), 30_000).unref();
  }

  /**
   * Generate an id from the supplied clock and six random bytes. Internal quote preparation, no
   * authentication; random-source failures throw.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  newId() {
    return `q_${this.now().toString(36)}${randomBytes(6).toString('hex')}`;
  }

  /**
   * Retain a quote with caller-supplied account attribution and consumed=false, replacing any
   * existing id. Caller authorizes the account; no ownership or expiry validation is performed here.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  put(quote: Quote, accountId: string) {
    this.quotes.set(quote.id, { quote, accountId, consumed: false });
  }

  /**
   * Return the retained quote/account/consumed state or undefined. Caller must check ownership,
   * consumed state and expiry; this lookup performs no authorization or expiry rejection.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  get(id: string): Stored | undefined {
    return this.quotes.get(id);
  }

  /**
   * Mark a retained quote consumed, doing nothing for unknown ids. Caller must authorize/check the
   * quote first; this is an in-memory flag, not an atomic admission decision.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  consume(id: string) {
    const q = this.quotes.get(id);
    if (q) q.consumed = true;
  }

  private gc() {
    const cutoff = this.now() - 5 * 60_000;
    for (const [id, q] of this.quotes) if (q.quote.expiresAt < cutoff) this.quotes.delete(id);
  }
}
