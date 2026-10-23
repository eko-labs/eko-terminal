import type { MockableSend } from './handler.js';
import type { TelegramNoticeSend } from '@eko/shared';

export const TELEGRAM_TRANSPORT_ENABLED = false;

/** grammY Api/InputFile adapter. Supply those objects only after dependency/release acceptance.
 * No Bot construction, token loading, polling, setWebhook or external calls occur here.
 */
export function grammySend<Photo>(api: {
  sendMessage(chatId: number, text: string, options: {
    reply_parameters: { message_id: number }; link_preview_options: { is_disabled: true };
  }): Promise<unknown>;
  sendPhoto(chatId: number, photo: Photo, options: { reply_parameters: { message_id: number } }): Promise<unknown>;
}, inputFile: (bytes: Uint8Array, filename: string) => Photo): MockableSend {
  return async reply => {
    if (!TELEGRAM_TRANSPORT_ENABLED) throw new Error('Telegram transport is disabled');
    const reply_parameters = { message_id: reply.messageId };
    // No parse_mode, inline keyboard, approval buttons, or source URLs.
    if (reply.image) await api.sendPhoto(reply.chatId, inputFile(reply.image, 'eko-verdict.png'), { reply_parameters });
    await api.sendMessage(reply.chatId, reply.text, { reply_parameters, link_preview_options: { is_disabled: true } });
  };
}

/** Prepared DM transport; no reply target, keyboard, actions, parse mode or previews. */
export function grammyNoticeSend(api: {
  sendMessage(chatId: number, text: string, options: { link_preview_options: { is_disabled: true } }): Promise<unknown>;
}): TelegramNoticeSend {
  return async notice => {
    if (!TELEGRAM_TRANSPORT_ENABLED) throw new Error('Telegram transport is disabled');
    await api.sendMessage(notice.chatId, notice.text, { link_preview_options: { is_disabled: true } });
  };
}
