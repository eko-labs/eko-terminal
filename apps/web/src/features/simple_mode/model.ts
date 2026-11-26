import { findingsFirst, projectGuardLevelToV1, type CoinCard, type Flow, type GuardAssessmentV2, type PlaybookId, type RadarRow, type ReasonCode, type Verdict } from '@eko/shared';
import { exitMeasured, sellCheckNotAvailable, sellCheckOf } from '../../lib/sellCheck';

/**
 * Simple view: every coin answers one question, "should I buy this?", in a word or two, with up to three plain reasons
 * a twelve-year-old could repeat and a few plain facts. No jargon. Everything here is pure, so it is tested without a
 * screen.
 */
export type AnswerKind = 'ok' | 'careful' | 'dont' | 'checking';
export interface Answer { kind: AnswerKind; word: string }

/** One plain sentence for each finding a verdict can name (packages/playbooks). */
export const PLAYBOOK_PLAIN: Record<PlaybookId, string> = {
  honeypot: 'You may not be able to sell it once you buy.',
  tax_trap: 'A big fee is taken every time you sell it.',
  removable_liquidity: 'The money behind it can be pulled out at any moment.',
  fee_trap_pool: 'The place it trades charges a huge fee to get out.',
  stuck_at_bonding: 'It stopped growing and almost nobody is buying.',
  wash_to_trend: 'Most of its trading is fake, to make it look busy.',
  clone_swarm: 'It copies another coin, down to the name.',
  exempt_insiders: "A few insiders don't pay the fees everyone else pays.",
  bundle_dump: 'A few wallets grabbed most of it right at the start.',
  migration_dump: 'Big holders sold a lot as soon as it took off.',
  malicious_hook: 'Hidden code can change what happens when you sell.',
  agent_bait: 'Its text tries to trick trading bots.',
  serial_deployer: 'The people who made it have made bad coins before.',
  holder_concentration: 'A few people own most of it.',
  dev_dump: 'The people who made it already sold most of theirs.',
  run_up: 'Its price already shot up, so it can fall hard.',
  launch_snipers: 'Fast bots bought a lot of it the moment it launched.',
  fake_mcap: 'Its price is mostly made up: almost no real money is behind it.',
};
/** A hook the rules have not reviewed is a caution, not a known trap (radarModel playbookName: "Unreviewed hook"). */
const UNREVIEWED_HOOK = "It has extra code that EKO hasn't checked yet.";

/** One plain sentence for each reason the guard can give (packages/shared guard-ids GUARD_REASON_CODES). */
export const REASON_PLAIN: Record<ReasonCode, string> = {
  EXIT_COST: 'Selling it again would cost you a big part of your money.',
  DEPTH: "There's little real money behind it, so the price jumps easily.",
  ENTRY_LIMIT: 'It limits how much anyone can buy at once.',
  SELL_RESTRICTION: 'You may not be able to sell it.',
  CONTROL: 'Its owner can still change the rules of the coin.',
  GROUP_HELD: 'One group of wallets holds a big part of it.',
  TOP_HOLDERS: 'A few people own most of it.',
  EARLY_BUYERS: 'The first buyers still hold a lot and could sell.',
  SAME_BLOCK: 'Many wallets bought at the very same moment, like one person.',
  ORIGIN_SALE: 'Wallets from its launch are selling what they got.',
  SELL_PRESSURE: 'Lots of people are selling it right now.',
  ATTRIBUTED_DUMP: 'The people behind it are selling theirs.',
  EXEMPTIONS: "A few insiders don't pay the fees everyone else pays.",
  CYCLING: 'Most of its trading is fake, to make it look busy.',
  CLONE: 'It copies another coin, down to the name.',
  HISTORY: 'The people who made it have made bad coins before.',
  TEXT_INSTRUCTION: 'Its text tries to trick trading bots.',
  INCOMPLETE: "EKO couldn't finish checking it yet.",
  POLICY_DENIAL: "EKO won't help anyone buy this one.",
};
export const WARNING_SIGNS = 'EKO found warning signs.';
export const NOTHING_WRONG = 'EKO checked it and found nothing wrong.';
export const STILL_CHECKING = 'EKO is checking it right now. Give it a minute.';
export const WATCHED_LATE = 'EKO started watching this coin late.';

const WORDS: Record<AnswerKind, string> = { ok: 'Looks OK', careful: 'Be careful', dont: "Don't buy", checking: 'Still checking' };
const KIND = { clear: 'ok', monitor: 'careful', danger: 'dont', pending: 'checking', info: 'careful' } as const;

/** The answer for a coin: its verdict's level (or an active guard's, which rules when there is one) in a word or two. */
export function answerOf(c: { level: string; pending?: boolean; historyPartial?: unknown; guard?: GuardAssessmentV2 | null }): Answer {
  if (c.guard?.mode === 'active') {
    const kind = KIND[projectGuardLevelToV1(c.guard.level)];
    return { kind, word: WORDS[kind] };
  }
  if (c.pending || c.level === 'pending') return { kind: 'checking', word: WORDS.checking };
  const kind = KIND[c.level as keyof typeof KIND] ?? 'checking';
  // Graded on part of the coin's history only: holders and early buyers were not counted, so it is not a plain OK.
  if (kind === 'ok' && c.historyPartial) return { kind, word: 'Looks OK so far' };
  return { kind, word: WORDS[kind] };
}

/** The one reason under the answer: the guard's first reason, else the strongest finding, else what the answer means. */
export function plainReason(verdict: Pick<Verdict, 'level' | 'playbooks' | 'historyPartial'> | null | undefined, guard?: GuardAssessmentV2 | null): string {
  if (guard?.mode === 'active') {
    const code = guard.reasons[0]?.code;
    if (code) return REASON_PLAIN[code];
    const kind = answerOf({ level: 'pending', guard }).kind;
    return kind === 'ok' ? NOTHING_WRONG : kind === 'checking' ? STILL_CHECKING : WARNING_SIGNS;
  }
  if (!verdict || verdict.level === 'pending') return STILL_CHECKING;
  const top = findingsFirst(verdict.playbooks)[0];
  if (top && verdict.level !== 'clear') return top.id === 'malicious_hook' && top.level === 'monitor' ? UNREVIEWED_HOOK : PLAYBOOK_PLAIN[top.id];
  if (verdict.level === 'clear') return verdict.historyPartial ? WATCHED_LATE : NOTHING_WRONG;
  return WARNING_SIGNS;
}

export type SellAnswer = 'yes' | 'maybe' | 'no' | 'unknown';
export const SELL_WORDS: Record<SellAnswer, string> = { yes: 'Yes', maybe: 'Maybe not', no: 'No', unknown: 'Not checked yet' };
/** Above this round-trip cost a sale is possible but loses so much that "yes" would mislead (the coin page's "Costly"). */
const COSTLY_PCT = 30;
/** Can you sell it later: the coin's sell check and what a round trip costs, as one word. */
export function canSell(card: CoinCard | null | undefined): SellAnswer {
  if (!card) return 'unknown';
  if (card.tradeability.honeypot || sellCheckOf(card) === 'refused') return 'no';
  if (sellCheckNotAvailable(card)) return 'unknown';
  // Judged on the small round trip a beginner makes ($100), else the $1K one.
  const size = exitMeasured(card, 'usd100') ? 'usd100' : exitMeasured(card, 'usd1k') ? 'usd1k' : null;
  if (!size) return 'unknown';
  return card.tradeability.exitCostPct[size] > COSTLY_PCT ? 'maybe' : 'yes';
}
/** What $100 bought and sold straight back returns, in whole dollars, or null when that was not measured. */
export function hundredBack(card: CoinCard | null | undefined): number | null {
  if (!card || canSell(card) === 'no' || !exitMeasured(card, 'usd100')) return null;
  const cost = card.tradeability.exitCostPct.usd100;
  if (!Number.isFinite(cost) || cost < 0 || cost >= 100) return null;
  return Math.max(1, Math.round(100 - cost));
}

/** "Up 12% today": a price move in whole percent, in words. */
export function moveText(pct: number | undefined, when: string): string | null {
  if (pct === undefined || !Number.isFinite(pct)) return null;
  const n = Math.round(Math.abs(pct));
  if (n === 0) return `About the same ${when}`.trim();
  return `${pct > 0 ? 'Up' : 'Down'} ${n.toLocaleString('en-US')}% ${when}`.trim();
}

/** How a reason or a fact reads: good news, a caution, a danger, or neither. */
export type Tone = 'good' | 'watch' | 'bad' | 'neutral';
export interface Reason { tone: Tone; text: string }
export const SOLD_OK = 'EKO tested selling it, and it worked.';
export const NO_POWERS = "Its makers can't change the rules or make more of it.";
export const LOCKED_IN = 'The money behind it is locked in.';

/** Good things EKO measured about a coin that looks OK: a working test sale, no owner powers, locked money. */
function goodFacts(card: CoinCard | null | undefined): string[] {
  if (!card) return [];
  const out: string[] = [];
  if (canSell(card) === 'yes' && sellCheckOf(card) === 'sellable') out.push(SOLD_OK);
  const c = card.control;
  if (c && !card.meta?.control?.unavailable && !c.canMint && !c.canPause && !c.canBlacklist && !c.canChangeTax && !c.upgradeable) out.push(NO_POWERS);
  const lp = card.liquidity?.lpStatus;
  if (lp && !card.meta?.liquidity?.unavailable && (lp === 'burned' || lp === 'locked' || lp === 'pons_locked')) out.push(LOCKED_IN);
  return out;
}

/**
 * Up to three plain reasons under the answer, the strongest first: a failed test sale, what the guard or the checks
 * found (dangers before cautions), and for a coin that looks OK the good things EKO measured. Never two the same.
 */
export function reasonsOf(verdict: Pick<Verdict, 'level' | 'playbooks' | 'historyPartial'> | null | undefined, guard?: GuardAssessmentV2 | null, card?: CoinCard | null): Reason[] {
  const out: Reason[] = [];
  const add = (tone: Tone, text: string) => { if (!out.some(r => r.text === text)) out.push({ tone, text }); };
  const kind = answerOf({ level: verdict?.level ?? 'pending', historyPartial: verdict?.historyPartial, guard }).kind;
  if (canSell(card) === 'no') add('bad', REASON_PLAIN.SELL_RESTRICTION);
  if (guard?.mode === 'active') { for (const r of guard.reasons) add(kind === 'dont' ? 'bad' : 'watch', REASON_PLAIN[r.code]); }
  else if (verdict && verdict.level !== 'clear' && verdict.level !== 'pending') {
    for (const m of findingsFirst(verdict.playbooks)) add(m.level === 'danger' ? 'bad' : 'watch', m.id === 'malicious_hook' && m.level === 'monitor' ? UNREVIEWED_HOOK : PLAYBOOK_PLAIN[m.id]);
  }
  if (kind === 'checking') { if (!out.length) add('neutral', STILL_CHECKING); return out.slice(0, 3); }
  if (!out.length) add(kind === 'ok' ? 'good' : 'watch', kind === 'ok' ? (verdict?.historyPartial ? WATCHED_LATE : NOTHING_WRONG) : WARNING_SIGNS);
  if (kind === 'ok') for (const fact of goodFacts(card)) add('good', fact);
  return out.slice(0, 3);
}

/** A plain fact in the glance row: a label, one short value, one plain line, a tone and, where Full has one, a gauge. */
export interface Fact { id: string; label: string; value: string; line: string; tone: Tone; gauge?: number }
/** "$4K": dollars in a few characters. */
export const dollars = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${Math.round(v)}`);
const SELL_LINES: Record<Exclude<SellAnswer, 'unknown'>, { line: string; tone: Tone }> = {
  yes: { line: 'EKO tested a sale', tone: 'good' }, maybe: { line: 'Selling costs a lot', tone: 'watch' }, no: { line: 'A test sale failed', tone: 'bad' },
};
/**
 * The glance row's facts, in plain words, each left out when its data is missing (never "not checked"): can you sell
 * it, what $100 gets back, today's move, the money behind it, how much the top ten own, and last hour's trading.
 */
export function factsOf(card: CoinCard | null | undefined, row: RadarRow | null | undefined): Fact[] {
  const out: Fact[] = [];
  const sell = canSell(card);
  if (sell !== 'unknown') out.push({ id: 'sell', label: 'Can you sell it?', value: SELL_WORDS[sell], ...SELL_LINES[sell] });
  const back = hundredBack(card);
  if (back !== null) out.push({ id: 'back', label: '$100 gets back', value: `$${back}`, line: 'If you sold right away', tone: back >= 90 ? 'good' : back >= 70 ? 'watch' : 'bad', gauge: back });
  const today = row && !row.unavailable?.includes('change') ? moveText(row.change24hPct, '') : null;
  if (today) out.push({ id: 'today', label: 'Today', value: today, line: 'Price over the last day', tone: 'neutral' });
  if (row && !row.unavailable?.includes('liquidity') && row.liquidityUsd > 0) {
    const curve = card?.identity.stage === 'curve' ? card.identity.curvePct ?? row.curvePct : undefined;
    const cap = row.unavailable?.includes('marketCap') ? undefined : row.marketCapUsd;
    if (curve !== undefined) out.push({ id: 'money', label: 'Money behind it', value: dollars(row.liquidityUsd), line: 'Still in its first sale', tone: 'neutral', gauge: curve });
    else if (cap && cap > 0) {
      const share = row.liquidityUsd / cap * 100, tone: Tone = share < 0.5 ? 'bad' : share < 2 ? 'watch' : 'good';
      out.push({ id: 'money', label: 'Money behind it', value: dollars(row.liquidityUsd), line: tone === 'bad' ? 'Very little for its price' : tone === 'watch' ? 'Thin for its price' : 'Plenty for its price', tone, gauge: share });
    }
  }
  const supply = card?.meta?.supply;
  if (card && !supply?.unavailable && !supply?.missing?.includes('top10Pct') && !supply?.flags?.includes('history_partial')) {
    const top = card.supply.top10Pct, tone: Tone = top > 50 ? 'bad' : top > 25 ? 'watch' : 'good';
    out.push({ id: 'top', label: 'Top 10 own', value: `${Math.round(top)}%`, line: tone === 'bad' ? 'A few people own a lot' : tone === 'watch' ? 'Some big holders' : 'Spread across many people', tone, gauge: top });
  }
  if (row && row.volume1hUsd !== undefined && !row.unavailable?.includes('volume')) {
    const v = row.volume1hUsd, trades = row.trades1h;
    out.push({ id: 'trading', label: 'Trading last hour', value: v < 1 ? '$0' : dollars(v),
      line: v < 1 ? 'Nobody traded it' : trades !== undefined ? `${trades.toLocaleString('en-US')} ${trades === 1 ? 'trade' : 'trades'}` : 'People are trading it', tone: 'neutral' });
  }
  return out;
}

/** Who's buying: last hour's buyers against its sellers, in a sentence, or null when nobody traded. */
export function whoIsBuying(flows: readonly Flow[]): { buyers: number; sellers: number; share: number; text: string } | null {
  const a = flows.find(f => f.window === '1h')?.activity;
  if (!a || a.buyers + a.sellers === 0) return null;
  const { buyers, sellers } = a, share = buyers / (buyers + sellers) * 100;
  const text = buyers > sellers * 1.2 ? 'More people are buying than selling' : sellers > buyers * 1.2 ? 'More people are selling than buying' : 'About as many people are buying as selling';
  return { buyers, sellers, share, text };
}
