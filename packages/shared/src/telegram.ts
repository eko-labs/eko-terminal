import { DYOR, NON_AFFILIATION } from './contracts/guard-copy.js';

/** Prepared BotFather description and /start copy; publishing requires authorization. */
export const TELEGRAM_DESCRIPTION = [
  'EKO scans public contract addresses and sends linked watchlist alerts. Manage alerts on the web.',
  DYOR, NON_AFFILIATION,
].join('\n');

/** The bot receives an opaque code and the private sender ID, never account or wallet data. */
export type TelegramLinkResult = 'linked' | 'invalid_code' | 'identity_conflict';
export interface TelegramLinkRedeemer {
  redeem(code: string, senderId: number): Promise<TelegramLinkResult>;
}
export interface TelegramNotice {
  chatId: number;
  text: string;
  /** Stable retry key for an accepted transport; no approval actions or buttons. */
  deliveryKey: string;
}
export type TelegramNoticeSend = (notice: TelegramNotice) => Promise<void>;
