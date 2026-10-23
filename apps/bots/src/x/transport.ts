export interface XMentionRequest { since_id?: string; pagination_token?: string; max_results: number }
/** Future API boundary; no OAuth, HTTP client, credentials or account setup in this packet. */
export interface XTransport {
  mentions(request: XMentionRequest): Promise<unknown>;
  upload(image: Uint8Array, contentType: 'image/png'): Promise<{ media_id: string }>;
  reply(input: { text: string; media_id: string; in_reply_to_tweet_id: string }): Promise<void>;
  post(input: { text: string; media_id: string }): Promise<void>;
}
export class XPlatformError extends Error {
  /**
   * Carry only HTTP status with fixed withheld-detail platform failure text. Construction performs
   * no request or authorization.
   */
  constructor(readonly status: number) { super('X platform operation failed'); }
}
const disabled = async (): Promise<never> => { throw new Error('X transport disabled'); };
/** Even with a flag enabled, the supplied production boundary cannot read or write X. */
export const disabledXTransport: XTransport = { mentions: disabled, upload: disabled, reply: disabled, post: disabled };
