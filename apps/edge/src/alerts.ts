import type { Alert } from '@eko/shared';

/**
 * In-site alerts per account, kept in memory: the server side of the alerts drawer. A part of the edge posts an alert
 * for an account; it is delivered at once to that account's open sockets (the `alerts` channel) and kept for the
 * drawer's catch-up read (`GET /v1/alerts?after=<seq>`). Bounded: the latest `perAccount` alerts of the
 * `accounts` most recently alerted accounts. A restart forgets them (alerts are in-site only; nothing is sent elsewhere).
 */
export interface AlertInboxOptions { perAccount?: number; accounts?: number }
export type AlertDeliver = (accountId: string, alert: Alert, seq: number) => void;

export class AlertInbox {
  private readonly byAccount = new Map<string, { seq: number; alert: Alert }[]>();
  private seq = 0;
  private readonly perAccount: number;
  private readonly maxAccounts: number;
  /** Set once the realtime socket is up (main.ts); until then alerts are only kept. */
  deliver: AlertDeliver | null = null;

  constructor(opts: AlertInboxOptions = {}) {
    this.perAccount = opts.perAccount ?? 100;
    this.maxAccounts = opts.accounts ?? 20_000;
  }

  /** Keep the alert for the account and push it to its open sockets. Returns its sequence number. */
  post(accountId: string, alert: Alert): number {
    const seq = ++this.seq;
    const rows = this.byAccount.get(accountId) ?? [];
    // Most recently alerted last, so the first key is the one to forget when full.
    this.byAccount.delete(accountId);
    rows.push({ seq, alert });
    if (rows.length > this.perAccount) rows.splice(0, rows.length - this.perAccount);
    this.byAccount.set(accountId, rows);
    while (this.byAccount.size > this.maxAccounts) this.byAccount.delete(this.byAccount.keys().next().value!);
    this.deliver?.(accountId, alert, seq);
    return seq;
  }

  /** The account's alerts after `after`, oldest first, in one page; `seq` is the newest sequence number it has seen. */
  page(accountId: string, after = 0): { rows: Alert[]; cursor: null; seq: number } {
    const rows = this.byAccount.get(accountId) ?? [];
    return { rows: rows.filter(r => r.seq > after).map(r => r.alert), cursor: null, seq: Math.max(after, rows.at(-1)?.seq ?? 0) };
  }

  erase(accountId: string) { this.byAccount.delete(accountId); }
}
