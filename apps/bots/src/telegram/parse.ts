import { z } from 'zod';

const id = z.number().int().refine(Number.isSafeInteger);
// Zod strips all unneeded fields before processing: names, handles, captions,
// forwarded messages, reply chains, attachments and message entities stay out.
export const UpdateSchema = z.object({
  update_id: id.nonnegative(),
  message: z.object({
    message_id: id.nonnegative(),
    date: id.nonnegative(),
    chat: z.object({ id, type: z.enum(['private', 'group', 'supergroup', 'channel']) }),
    from: z.object({ id: id.positive(), is_bot: z.boolean() }).optional(),
    sender_chat: z.object({ id }).optional(),
    text: z.string().max(4096).optional(),
  }).optional(),
});
export type TelegramUpdate = z.infer<typeof UpdateSchema>;
export type Intent = { kind: 'ignore' } | { kind: 'ambiguous' } | { kind: 'scan'; query: string } | { kind: 'link'; code: string } |
  { kind: 'guidance'; command: 'scan' | 'bags' | 'alerts' | 'help' | 'start' };

/** Extract only bounded addresses/tickers. Message prose never enters scans or replies. */
export function parseIntent(text: string): Intent {
  if (text.length > 4096) return { kind: 'ignore' };
  const command = /^\/(\w+)(?:@[a-zA-Z0-9_]+)?(?:\s|$)/.exec(text);
  if (command) {
    if (!['scan', 'bags', 'alerts', 'help', 'start'].includes(command[1])) return { kind: 'ignore' };
    if (command[1] === 'start') {
      const code = text.slice(command[0].length).trim();
      if (/^[A-Za-z0-9_-]{43}$/.test(code)) return { kind: 'link', code };
    }
    if (command[1] !== 'scan') return { kind: 'guidance', command: command[1] as 'bags' | 'alerts' | 'help' | 'start' };
    text = text.slice(command[0].length);
  }
  const addresses = [...text.matchAll(/(?<![\w])0x[0-9a-fA-F]{40}(?![\w])/g)].map(m => m[0].toLowerCase());
  const tickers = [...text.matchAll(/(?<![\w$])\$[a-zA-Z][a-zA-Z0-9_]{0,31}(?![\w])/g)].map(m => m[0].toUpperCase());
  const targets = [...new Set([...addresses, ...tickers])];
  // TODO(spec): mixed or multiple targets ask for one address; never pick a target from prose.
  if (targets.length > 1) return { kind: 'ambiguous' };
  if (targets.length === 1) return { kind: 'scan', query: targets[0] };
  return command ? { kind: 'guidance', command: 'scan' } : { kind: 'ignore' };
}
