import { timingSafeEqual } from 'node:crypto';
import { AddressSchema, ScanResultSchema, TELEGRAM_DESCRIPTION, guardNotification, type ScanResult, type TelegramLinkRedeemer } from '@eko/shared';
import { parseIntent, UpdateSchema } from './parse.js';
import { TelegramStore, type Caller } from './store.js';

export interface Reply { chatId: number; messageId: number; text: string; image?: Uint8Array }
export interface TelegramServices {
  scan(query: string): Promise<ScanResult>;
  /** Renderer 111: a validated, deterministic 1200x675 PNG for this exact snapshot. */
  image?(result: ScanResult): Promise<Uint8Array | null>;
  /** Scoreboard 112: accepted 24-hour outcome relative to its launch cohort. */
  grade?(call: Caller): Promise<unknown>;
  link?: TelegramLinkRedeemer;
}
export type MockableSend = (reply: Reply) => Promise<void>;
const ambiguous = 'More than one token matches. Paste one contract address to scan.';

export class TelegramHandler {
  private readonly origin: string;
  /**
   * Validate webhook secret format and HTTPS public origin, and wire injected storage/read/send
   * services. Host construction starts no listener or bot client.
   */
  constructor(readonly store: TelegramStore, readonly services: TelegramServices,
    private readonly send: MockableSend, private readonly secret: string, publicOrigin: string) {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error('Invalid Telegram webhook secret configuration');
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Telegram public origin must be an HTTPS origin');
    }
    this.origin = url.origin;
  }
  /**
   * Compare a supplied secret against configured bytes in constant time after length checking.
   * Nonstring or unequal values return false; no update is claimed or parsed.
   */
  validSecret(raw: unknown) {
    if (typeof raw !== 'string') return false;
    const actual = Buffer.from(raw), expected = Buffer.from(this.secret);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  /** Only fixture/injected sends are used in this packet. No listener or bot is started. */
  async receive(pathSecret: unknown, headerSecret: unknown, raw: unknown): Promise<{ status: number; state: string }> {
    if (!this.validSecret(pathSecret) || !this.validSecret(headerSecret)) return { status: 403, state: 'forbidden' };
    const parsed = UpdateSchema.safeParse(raw);
    if (!parsed.success) return { status: 422, state: 'invalid_update' };
    const update = parsed.data;
    if (!await this.store.claim(update.update_id)) return { status: 200, state: 'duplicate' };
    try {
      const message = update.message;
      if (!message?.text || !message.from || message.from.is_bot || message.sender_chat || message.chat.type === 'channel') {
        await this.store.finish(update.update_id, 'ignored');
        return { status: 200, state: 'ignored' };
      }
      const intent = parseIntent(message.text);
      if (intent.kind === 'ignore') {
        await this.store.finish(update.update_id, 'ignored');
        return { status: 200, state: 'ignored' };
      }
      let text: string, image: Uint8Array | undefined;
      if (intent.kind === 'link') {
        // Deep-link codes can only be redeemed by the sender in their own private DM.
        if (message.chat.type !== 'private' || message.chat.id !== message.from.id) {
          await this.store.finish(update.update_id, 'ignored');
          return { status: 200, state: 'ignored' };
        }
        const result = await this.services.link?.redeem(intent.code, message.from.id);
        text = [result === 'linked' ? 'Telegram alerts linked. Manage or unlink notifications on the web.' :
          result === 'identity_conflict' ? 'This Telegram identity is already linked. Unlink it from its account on the web first.' :
          'Link unavailable or expired. Request a new link on the web.', TELEGRAM_DESCRIPTION,
          `Alert settings: ${this.origin}/watch`].join('\n');
      } else if (intent.kind === 'ambiguous') text = ambiguous;
      else if (intent.kind === 'guidance') {
        text = this.guidance(intent.command);
        if (message.chat.type !== 'private' && ['help', 'start'].includes(intent.command)) {
          const { groupKey } = this.store.identities(message.chat.id, message.from.id);
          if (this.services.grade) await this.store.gradePending(groupKey, this.services.grade);
          const board = await this.store.leaderboard(groupKey);
          if (board.badge) text += `\n${board.badge}\nCaller record: ${board.rows.reduce((n, r) => n + r.calls, 0)} calls · ${board.rows.reduce((n, r) => n + r.pending, 0)} pending\n` +
            board.rows.slice(0, 10).map(r => `${r.caller}: ${r.above} above cohort · ${r.at} at cohort · ${r.below} below cohort · ${r.pending} pending`).join('\n');
        }
      } else {
        const result = ScanResultSchema.parse(await this.services.scan(intent.query));
        // Treat the scan's URLs, messages, names and candidates as data, never output prose.
        const record = this.scanLink(result.id);
        const coin = this.coin(intent.query, result);
        let caller: Caller | undefined;
        if (coin && message.chat.type !== 'private') {
          caller = await this.store.first({ ...this.store.identities(message.chat.id, message.from.id), coin,
            scanId: result.id, calledAt: Math.min(message.date * 1000, this.store.now()) });
        }
        if (result.status === 'ambiguous') text = ambiguous;
        else if (result.status === 'not_found') text = 'No indexed token matches. Paste a contract address.';
        else {
          // Always negotiate Guard 2 explicitly; missing cards never fall back to a Clear V1 label.
          text = guardNotification({ version: 2, assessment: result.guardCard?.verdict ?? null });
          if (result.status === 'pending') text += '\nScan pending · awaiting indexed evidence.';
          if (result.status === 'ready' && result.guardCard && this.services.image) {
            try { image = await this.services.image(result) ?? undefined; } catch { /* text remains available */ }
          }
          if (!image) text += '\nVerdict image unavailable.';
        }
        text += `\nRecord: ${record}`;
        if (caller) {
          if (this.services.grade && this.store.now() >= caller.calledAt + 86400000) {
            await this.store.appendGrade(await this.services.grade(caller));
          }
          const grade = await this.store.grade(caller.id);
          text += `\nFirst caller record: ${this.scanLink(caller.scanId)} · ${caller.id}\n24-hour outcome: ${grade?.grade.replaceAll('_', ' ') ?? 'pending'}`;
        }
      }
      await this.send({ chatId: message.chat.id, messageId: message.message_id, text, ...(image ? { image } : {}) });
      await this.store.finish(update.update_id, 'sent');
      return { status: 200, state: 'sent' };
    } catch {
      // Provider errors can contain message text or URLs with credentials: persist only a fixed state.
      await this.store.finish(update.update_id, 'failed');
      return { status: 200, state: 'failed' };
    }
  }
  private scanLink(id: string) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Invalid scan record ID');
    return `${this.origin}/scan/${id}`;
  }
  private coin(query: string, result: ScanResult) {
    if (result.status === 'ambiguous' || result.status === 'not_found') return undefined;
    const address = AddressSchema.safeParse(query);
    const coin = result.card?.identity.address ?? result.guardCard?.identity.address ??
      (result.candidates?.length === 1 ? result.candidates[0].address : undefined) ?? (address.success ? address.data : undefined);
    // A corrupt resolver may not reassign an address caller to a different coin.
    if (address.success && coin !== address.data) throw new Error('Scan target mismatch');
    if (result.card && result.guardCard && result.card.identity.address !== result.guardCard.identity.address) throw new Error('Scan card mismatch');
    if (result.guardCard?.verdict && result.guardCard.verdict.coin !== coin) throw new Error('Guard assessment mismatch');
    return coin;
  }
  private guidance(command: 'scan' | 'bags' | 'alerts' | 'help' | 'start') {
    if (command === 'bags') return `Scan my bags on the web: ${this.origin}/bags`;
    if (command === 'alerts') return `Manage watchlist alerts on the web: ${this.origin}/settings`;
    if (command === 'scan') return 'Use /scan with one contract address or $TICKER.';
    return [TELEGRAM_DESCRIPTION, 'EKO checks pasted addresses and tickers. Group messages are not stored.',
      'Caller records retain a contract, scan reference, time and group-scoped pseudonymous identifiers.',
      '24-hour caller grades remain pending until accepted launch-cohort outcomes are available.',
      '/scan · paste one contract address or $TICKER', `/bags · ${this.origin}/bags`, `/alerts · ${this.origin}/settings`,
      'Scans and web link guidance only. We never receive your Robinhood credentials.',
      guardNotification({ version: 2, assessment: null })].join('\n');
  }
}
