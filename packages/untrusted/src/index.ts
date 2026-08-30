import type { Untrusted } from '@eko/shared';

export const UNTRUSTED_LIMITS = { name: 64, symbol: 16, description: 280, socialHandle: 64 } as const;
export const DEFAULT_MAX_SCAN_CHARS = 4000;

// BACKEND §9.5: escaped controls only; keep tabs and line feeds until role detection.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF0-\uFFFF]/g;
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const ROLE_MARKERS = /(<\|[^|]{0,20}\|>|\[\/?(INST|SYS)\]|^\s*(system|assistant|user|developer)\s*:|###\s*(instruction|system))/im;
const DOT = String.raw`(?:\.|\[\.\]|\(\.\)|\[dot\]|\(dot\))`;
const TLD = [
  'com', 'net', 'org', 'io', 'xyz', 'app', 'gg', 'fun', 'ai', 'co', 'me', 'so', 'sh', 'to', 'cc', 'tv', 'ly', 'fm', 'im', 'is', 'ws', 'gl',
  'lol', 'meme', 'bet', 'vip', 'pro', 'top', 'club', 'site', 'online', 'live', 'link', 'click', 'info', 'biz', 'dev', 'tech', 'finance',
  'money', 'cash', 'exchange', 'trade', 'claim', 'claims', 'gift', 'zone', 'world', 'network', 'digital', 'capital', 'chat', 'bot', 'wtf',
  'us', 'uk', 'eu', 'ru', 'cn', 'in', 'tk', 'ml', 'ga', 'cf', 'gq', 'xn--[a-z0-9-]{2,59}',
].join('|');
const LINK = new RegExp(String.raw`(?:\b(?:https?|hxxps?|ftp):\/\/|\bwww\.)\S+|\bt\s*\.\s*me\b(?:\/\S*)?|\b[a-z0-9-]+(?:${DOT}[a-z0-9-]+)*${DOT}(?:${TLD})\b(?:\/\S*)?`, 'i');
// Detection regexes are non-global so repeated calls cannot inherit lastIndex.
const ROLE_MARKERS_G = new RegExp(ROLE_MARKERS.source, 'gim');
const LINK_G = new RegExp(LINK.source, 'gi');
// General phrases need a model-role or override context: community invitations
// and meme copy using "you are now" or "act as" are not persona hijacks.
const ROLE_ASSIGNMENT = /\b(?:you\s+are\s+now|act\s+as)\s+(?:(?:an?|the|my)\s+)?(?:(?:unrestricted|uncensored|helpful)\s+)*(?:ai|agent|assistant|llm|model|bot|system|developer|dan)\b/;
const OVERRIDE_MODE = /\b(?:enable|activate|enter|use|in|switch\s+to)\s+(?:(?:the|a)\s+)?(?:developer\s+mode|jailbreak(?:\s+mode)?|dan(?:\s+mode)?)\b|\b(?:developer\s+mode|jailbreak|dan\s+mode)\s*(?::|activated\b|enabled\b)/;
const NEW_INSTRUCTIONS = /\bnew\s+instructions\s*:|\b(?:follow|obey|apply)\s+(?:(?:these|the)\s+)?new\s+instructions\b/;
// Match a command at a clause boundary, not narration such as "we send".
// Amount words need a financial object (or stand alone) so "send all memes"
// stays ordinary text. Keep the target in the same clause as the command.
const FUND_COMMAND = /(?:^|[.!?;:,\n]|\b(?:and|then))\s*(?:please\s+)?(?:transfer|send|approve|withdraw|drain|bridge)\b[^.!?;:\n]*?(?:\b0x[a-f0-9]{40}\b|\b(?:all|max(?:imum)?|unlimited)\b(?=\s*(?:$|[.!?;:,\n])|\s+(?:(?:of\s+)?(?:your|the|my|our)\s+)?(?:(?:available|remaining)\s+)?(?:eth|weth|btc|wbtc|usdc|usdt|usdg|dai|eko|crypto(?:currency)?|funds?|tokens?|coins?|assets?|balances?|holdings?|allowances?|approvals?|spending|amounts?)\b))/;

// TODO(spec): §9.5 references clone_swarm's table but supplies none. Use explicit
// Latin look-alikes for Cyrillic/Greek; NFKC handles fullwidth characters.
const CONFUSABLES: Readonly<Record<string, string>> = {
  '\u0430': 'a', '\u0432': 'b', '\u0441': 'c', '\u0501': 'd', '\u0435': 'e',
  '\u04bb': 'h', '\u0456': 'i', '\u0458': 'j', '\u043a': 'k', '\u04cf': 'l',
  '\u043c': 'm', '\u043e': 'o', '\u0440': 'p', '\u0455': 's', '\u0442': 't',
  '\u0443': 'y', '\u0445': 'x', '\u051b': 'q', '\u051d': 'w',
  '\u03b1': 'a', '\u03b2': 'b', '\u03f2': 'c', '\u03b5': 'e', '\u03b7': 'h',
  '\u03b9': 'i', '\u03ba': 'k', '\u03bc': 'm', '\u03bd': 'v', '\u03bf': 'o',
  '\u03c1': 'p', '\u03c4': 't', '\u03c5': 'y', '\u03c7': 'x',
};

function normalize(t: string): string {
  // U+061C is a bidi control outside the sketch's INVISIBLE ranges.
  return t.normalize('NFKC').replace(INVISIBLE, '').replace(/\u061C/g, '').replace(/。/g, '.');
}

function foldConfusables(t: string): string {
  return t.replace(/[\u0370-\u052F]/g, (char) => CONFUSABLES[char] ?? char);
}

function looksLikeImpersonation(t: string, trending: string[]): boolean {
  // TODO(spec): no similarity threshold is specified; use non-empty equality
  // after NFKC, lowercasing, confusable folding and whitespace normalization (§7.2).
  const key = normalizeIdentity;
  const candidate = key(t);
  return candidate !== '' && trending.some((value) => key(value) === candidate);
}

/** Shared identity folding for impersonation detection and clone_swarm.
 * @remarks
 * Fold identity text using NFKC, control stripping, specified confusables, lowercase extensions
 * and whitespace normalization. Public pure text operation without auth; it is a comparison key,
 * not a unique identity proof; nonstring inputs can throw.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function normalizeIdentity(value: string): string {
  // TODO(spec): no full Unicode casefold table is specified. Extend lowercasing
  // with sharp-s and final-sigma folding; reuse the existing confusable table.
  return foldConfusables(normalize(value).toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ'))
    .replace(/\s+/g, ' ').trim();
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Character limit must be a non-negative safe integer');
}

/**
 * Scan only a bounded raw UTF-16 prefix for implemented bidi, role/override, financial command and
 * hidden-instruction patterns. Public pure operation without auth; invalid cap throws RangeError.
 * A false result covers only these heuristics within the scanned prefix.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function isAgentBait(t: string, maxScanChars = DEFAULT_MAX_SCAN_CHARS): boolean {
  validateLimit(maxScanChars);
  // TODO(spec): §7.3 supplies a scan cap without defining its units/order. Bound
  // the raw UTF-16 prefix before normalization, matching §9.5's string lengths.
  const raw = t.slice(0, maxScanChars);
  // Test bidi evidence before stripping it; the red-team fixture requires a hit.
  if (BIDI.test(raw)) return true;
  const normalized = normalize(raw);
  const s = foldConfusables(normalized.toLowerCase());
  const addressed = /\b(ai|agent|assistant|llm|model|gpt|claude|bot)s?\b/.test(s);
  const imperative = /\b(ignore|disregard|forget|override)\b.{0,40}\b(instruction|prompt|rule|previous)|\byou (must|should|are required to)\b|\bsystem prompt\b/.test(s);
  const action = /\b(buy|approve|transfer|send|swap|sign|call the tool|execute)\b/.test(s);
  const hidden = /[A-Za-z0-9+/]{80,}={0,2}/.test(normalized) || /"(tool|function)_?(call|name)"\s*:/.test(s);
  const personaHijack = ROLE_ASSIGNMENT.test(s) || OVERRIDE_MODE.test(s) || NEW_INSTRUCTIONS.test(s);
  return (addressed && (imperative || action)) || imperative || personaHijack || FUND_COMMAND.test(s) || hidden || ROLE_MARKERS.test(normalized);
}

/**
 * Normalize third-party text, mark implemented bait/link/impersonation heuristics, remove
 * role/link markup and boundedly truncate into an Untrusted value. Public pure operation without
 * auth; invalid length throws RangeError. Consumers must still treat returned text as data rather
 * than instructions.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function toUntrusted(raw: string | null | undefined, maxLen: number, ctx?: { trending?: string[] }): Untrusted {
  validateLimit(maxLen);
  const flags = new Set<Untrusted['flags'][number]>();
  let t = normalize(raw ?? '');
  if (isAgentBait(raw ?? '')) flags.add('agent_bait');
  if (LINK.test(t)) flags.add('link');
  if (ctx?.trending && looksLikeImpersonation(t, ctx.trending)) flags.add('impersonation');
  t = t.replace(ROLE_MARKERS_G, '⟦removed⟧').replace(LINK_G, '⟦link⟧').replace(/[<>`]/g, '').replace(/\s+/g, ' ').trim();
  const truncated = t.length > maxLen;
  const text = truncated ? (maxLen === 0 ? '' : t.slice(0, maxLen - 1) + '…') : t;
  return { text, truncated, flags: [...flags] };
}
