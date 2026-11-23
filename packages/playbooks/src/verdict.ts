import type { Level, PlaybookId, PlaybookMatch, Verdict } from '@eko/shared';
import { CONFIG_V1, type PlaybookConfig } from '../config/v1.js';
import { readMarketCap } from './rules.js';
import type { CardSources, VerdictMeta } from './types.js';

const templates: Record<PlaybookId, string> = {
  honeypot: 'A deep simulation confirmed a failed sell or less than 5% returned.',
  tax_trap: 'Measured trading tax meets a fixed-tax or mutable-tax threshold.',
  removable_liquidity: 'Deployer/crew liquidity is removable or 2% depth is thin.',
  fee_trap_pool: 'A pool charges a fee of at least 15%.',
  stuck_at_bonding: 'Curve volume is concentrated in clusters with little progress.',
  wash_to_trend: 'Estimated wash activity or volume per trader meets a threshold.',
  clone_swarm: 'Normalized identity matches an older trending coin.',
  exempt_insiders: 'Snipe-tax-exempt wallets bought supply or have crew rug history.',
  bundle_dump: 'A bundle (wallets one buyer controls) or the first minute\'s buyers took a large share of supply.',
  migration_dump: 'Insiders sold holdings in the graduation window.',
  malicious_hook: 'Hook permissions or observed quote/fee behavior meet a threshold.',
  agent_bait: 'Token text contains instructions aimed at agents.',
  serial_deployer: 'Deployer/crew launch history meets a repeat-launch threshold.',
  holder_concentration: 'A few wallets hold a large share of supply.',
  dev_dump: 'The deployer sold on buyers or holds a large share of supply.',
  run_up: 'Much of the supply has already been bought out of the launch curve.',
  launch_snipers: 'Wallets bought in the first seconds after launch and hold a large share of supply.',
  fake_mcap: 'The market cap is far above what buyers have paid into the pool.',
};
const rank: Record<Level, number> = { danger: 3, monitor: 2, info: 1, clear: 0 };

/** Dollars as a trader reads them: $0.89, $745, $39.3K, $781K, $1.02M, $405M, $1.2B. */
export function compactUsd(n: number): string {
  const sig = (v: number) => (v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100).toString();
  const a = Math.max(0, n);
  if (a >= 999.5e6) return `$${sig(a / 1e9)}B`;
  if (a >= 999.5e3) return `$${sig(a / 1e6)}M`;
  if (a >= 999.5) return `$${sig(a / 1e3)}K`;
  return `$${a >= 100 ? Math.round(a) : a.toFixed(2)}`;
}
/** A share as a percentage: 28%, 3.8%, 0.19%, under 0.01%. */
export function sharePct(share: number): string {
  const p = Math.max(0, share) * 100;
  if (p === 0) return '0%';
  if (p < 0.01) return 'under 0.01%';
  return `${p >= 10 ? Math.round(p) : p >= 1 ? Math.round(p * 10) / 10 : Math.round(p * 100) / 100}%`;
}
/** A span in words: 40 minutes, 5 hours, 3 days, 4 weeks, 3 months; `adjective` gives "5-hour" as in "a 5-hour-old coin". */
export function ageWords(sec: number, adjective = false): string {
  const [n, unit] = sec < 2 * 3600 ? [Math.max(1, Math.round(sec / 60)), 'minute'] : sec < 48 * 3600 ? [Math.round(sec / 3600), 'hour']
    : sec < 14 * 86_400 ? [Math.round(sec / 86_400), 'day'] : sec < 60 * 86_400 ? [Math.round(sec / (7 * 86_400)), 'week'] : [Math.round(sec / (30 * 86_400)), 'month'];
  return adjective ? `${n}-${unit}` : `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** The launch window in words: about a second on Elysium, 3.5 seconds on Robinhood Chain (to the half second). */
const within = (sec: number | null) => sec == null || sec < 1.25 ? 'within a second of launch' : `within ${Math.round(sec * 2) / 2} seconds of launch`;

export function reasonForMatch(match: PlaybookMatch): string {
  if (match.id === 'honeypot' && match.level === 'info') return 'The contract probe failed; a honeypot has not been confirmed by deep simulation.';
  // Without a deep simulation (Elysium has no trace API), Danger rests on the buy-then-sell probe alone: say so.
  if (match.id === 'honeypot' && match.level === 'danger' && match.evidence.filter((e) => e.label === 'Buy-then-sell simulation').length === 1)
    return 'A buy-then-sell test could not sell, or got back less than 5% of what it paid.';
  if (match.id === 'fake_mcap') {
    const value = (label: string) => { const v = match.evidence.find((e) => e.kind === 'stat' && e.label === label)?.value; return typeof v === 'number' && Number.isFinite(v) ? v : null; };
    const mcap = value('Market cap, price × supply (USD)'), pool = value('In its pool (USD)'), share = value('In its pool as a share of market cap');
    const volume = value('24h volume (USD)'), hour = value('Last hour volume (USD)'), holders = value('Holders'), age = value('Coin age (seconds)');
    if (mcap != null && pool != null && share != null) {
      const backed = `${compactUsd(mcap)} market cap with ${compactUsd(pool)} in its pool (${sharePct(share)})`;
      if (match.level === 'danger') {
        const traded = hour != null ? hour < 0.5 ? 'nothing traded in the last hour' : `${compactUsd(hour)} traded in the last hour`
          : volume != null ? volume < 0.5 ? 'nothing traded in 24 hours' : `${compactUsd(volume)} traded in 24 hours` : null;
        const few = holders != null && holders <= 3 ? `${holders} holder${holders === 1 ? '' : 's'}` : null;
        const rest = [traded, few].filter(Boolean) as string[];
        return `A ${backed}${rest.length ? `${rest.length > 1 ? `, ${rest[0]} and ${rest[1]}` : ` and ${rest[0]}`}` : ''}: the price rests on almost nothing.`;
      }
      return age != null && age < CONFIG_V1.fake_mcap.youngH * 3600 ? `A ${ageWords(age, true)}-old coin at a ${backed}: its price ran far ahead of what the pool holds.`
        : `A ${backed}: thin for its size, so a large sell would move the price a long way.`;
    }
  }
  if (match.id === 'launch_snipers') {
    const value = (label: string) => { const v = match.evidence.find((e) => e.kind === 'stat' && e.label === label)?.value; return typeof v === 'number' && Number.isFinite(v) ? v : null; };
    const wallets = value('Launch snipers'), bought = value('Snipers bought supply share'), held = value('Snipers still hold supply share'), tip = value('Highest sniper priority fee (gwei)');
    const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
    if (wallets != null && bought != null && held != null)
      return `${wallets} wallet${wallets === 1 ? '' : 's'} bought ${pct(bought)} of supply ${within(value('Sniper window (seconds)'))}${tip != null && tip > 0 ? `, paying priority fees up to ${tip} gwei` : ''}; ${wallets === 1 ? 'it still holds' : 'they still hold'} ${pct(held)}.`;
  }
  if (match.id === 'tax_trap') {
    const creator = match.evidence.find((e) => e.kind === 'stat' && e.label === 'Creator tax getter (%)');
    const fee = match.evidence.find((e) => e.kind === 'stat' && e.label === 'Pons fee getter (%)');
    if (typeof creator?.value === 'number' && Number.isFinite(creator.value) && typeof fee?.value === 'number' && Number.isFinite(fee.value))
      return `Observed creator-tax getter ${creator.value}% and Pons-fee getter ${fee.value}%.`;
    // Measured from executed trades (a sell check's round trip, or what a coin's own buys and sells delivered).
    const leg = (label: string) => { const v = match.evidence.find((e) => e.kind === 'stat' && e.label === label)?.value; return typeof v === 'number' && Number.isFinite(v) ? v : null; };
    const buy = leg('Measured buy tax (%)'), sell = leg('Measured sell tax (%)');
    // Only where no launchpad getter was read: a Pons reason never falls back from its getters to another number.
    if (!creator && !fee && buy != null && sell != null) return buy < 0.5 && sell < 0.5 ? 'No transfer tax shows in this coin\'s recent buys and sells.'
      : `A buy loses about ${buy}% and a sell about ${sell}% to this coin's tax and fees (measured from trades).`;
  }
  if (match.id === 'bundle_dump') {
    const value = (label: string) => { const v = match.evidence.find((e) => e.kind === 'stat' && e.label === label)?.value; return typeof v === 'number' && Number.isFinite(v) ? v : null; };
    const bought = value('Early buyers bought supply share'), held = value('Early buyers still hold supply share'), wallets = value('Early buyer wallets'), bundled = value('Wallets bought by one funder');
    const dev = value('Deployer early bought supply share');
    const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
    // Held counts only the same wallets: early wallets often send tokens on to others, so a low share is not an exit.
    const now = held == null ? '' : `; ${wallets === 1 ? 'that wallet now holds' : 'those wallets now hold'} ${pct(held)}${bought != null && held < bought / 2 ? ' (sold or moved to other wallets)' : ''}`;
    // A bundle linked by its own transactions, told apart from copy traders (each in its own transaction, through one bot).
    const lBought = value('Bundle bought supply share'), lSold = value('Bundle sold supply share'), lHeld = value('Bundle still holds supply share');
    const lWallets = value('Bundle wallets'), lLaunch = value('Bundle wallets that bought at launch'), lLast = value('Bundle last sell (seconds after launch)');
    const bundle = lBought == null || lWallets == null || lLaunch == null ? null
      : `A bundle: ${lLaunch} wallet${lLaunch === 1 ? '' : 's'} bought ${pct(lBought)} of supply${value('Bundle bought in one transaction') ? ' in one transaction' : ''} at launch`
        + `${lWallets > lLaunch ? ` and passed it through ${lWallets - lLaunch} more` : ''}`
        + (lHeld != null && lSold != null ? (lHeld < 0.0005 && lSold > 0 ? `; it has sold all of it${lLast != null ? ` within ${lLast < 120 ? `${Math.round(lLast)} seconds` : `${Math.round(lLast / 60)} minutes`}` : ''}` : `; it has sold ${pct(lSold)} and holds ${pct(lHeld)}`) : '');
    const cWallets = value('Copy trader wallets'), cBots = value('Copy trading bots'), cBought = value('Copy traders bought supply share'), cSold = value('Copy traders sold supply share');
    const copies = cWallets == null || cBots == null ? null
      : `${cWallets} of ${bundle ? 'those' : 'the early'} wallets were copy traders, not a bundle: they bought through ${cBots === 1 ? 'one trading bot' : `${cBots} trading bots`}, each wallet in its own transaction`
        + (cBought != null && cSold != null && cSold > 0 ? (cSold >= cBought * 0.95 ? ', and sold everything they bought' : `; they bought ${pct(cBought)} and have sold ${pct(cSold)}`) : '');
    const whoRest = wallets != null ? `${wallets} ${bundle ? 'other ' : ''}wallet${wallets === 1 ? '' : 's'}${dev ? ', the deployer among them,' : ''}` : '';
    const cohortText = [bought != null && wallets != null ? `${whoRest} bought ${pct(bought)} of supply in the first minute${now}` : null,
      bundled != null ? `${bundled} wallets were bought for by one funder` : null].filter(Boolean).join('; ');
    const parts = [bundle, cohortText || null, copies].filter((p): p is string => !!p).map((p) => p.replace(/^./, (c) => c.toUpperCase()));
    if (parts.length) return `${parts.join('. ')}.`;
  }
  if (match.id === 'run_up') {
    const value = (label: string) => { const v = match.evidence.find((e) => e.kind === 'stat' && e.label === label)?.value; return typeof v === 'number' && Number.isFinite(v) ? v : null; };
    const out = value('Supply bought out of the launch curve'), hour = value('Net supply bought in the last hour'), age = value('Coin age (seconds)');
    const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
    // A coin under an hour old was bought entirely "in the last hour": say how long it took instead.
    const fast = match.level !== 'danger' || hour == null ? '' : age != null && age < 3600 ? `, all in the ${Math.max(1, Math.round(age / 60))} minute${Math.round(age / 60) > 1 ? 's' : ''} since launch` : `, ${pct(hour)} of supply in the last hour`;
    if (out != null) return `${pct(out)} of supply has been bought out of the launch curve${fast}.`;
  }
  if (match.id === 'holder_concentration' || match.id === 'dev_dump') {
    const value = (label: string) => { const v = match.evidence.find((e) => e.kind === 'stat' && e.label === label)?.value; return typeof v === 'number' && Number.isFinite(v) ? v : null; };
    const pct = (n: number) => `${Math.round(n * 1000) / 10}%`, usd = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
    const parts: string[] = [];
    if (match.id === 'holder_concentration') {
      const top10 = value('Top 10 holders supply share'), largest = value('Largest non-deployer holder supply share'), moved = value('Supply held by top holders that never bought'), wallets = value('Top holders that never bought');
      if (top10 != null && top10 >= 0.2) parts.push(`The top 10 holders own ${pct(top10)} of supply`);
      if (largest != null && largest >= 0.1) parts.push(`one wallet other than the deployer owns ${pct(largest)}`);
      if (moved != null && moved >= 0.05 && wallets) parts.push(`${wallets} of the largest holders never bought and hold${wallets === 1 ? 's' : ''} ${pct(moved)} (transferred in)`);
    } else {
      const held = value('Deployer holds supply share'), sold = value('Deployer sold supply share'), into = value('Deployer bought (USD)'), out = value('Deployer sold (USD)'), first = value('Deployer first sell (seconds after launch)');
      if (value('Deployer dumped') && into != null && out != null && sold != null && first != null)
        parts.push(`The deployer put in ${usd(into)}, took out ${usd(out)} (${pct(sold)} of supply) and first sold ${Math.round(first)} seconds after launch`);
      if (held != null && held >= 0.05) parts.push(`${parts.length ? 'it' : 'The deployer'} still holds ${pct(held)} of supply`);
    }
    if (parts.length) return `${parts.join('; ')}.`.replace(/^./, (c) => c.toUpperCase());
  }
  if (match.id === 'removable_liquidity') {
    const pulled = match.evidence.find((e) => e.kind === 'stat' && e.label === 'Deployer liquidity removed (share of its peak)')?.value;
    if (typeof pulled === 'number' && Number.isFinite(pulled) && pulled > 0)
      return pulled >= 0.995 ? 'The deployer took all the liquidity it had added out of this coin\'s pool.' : `The deployer took ${Math.round(pulled * 1000) / 10}% of the liquidity it had added out of this coin's pool.`;
    const provider = match.evidence.find((e) => e.kind === 'stat' && e.label === 'Launch liquidity removed by its provider (share of its peak)')?.value;
    if (typeof provider === 'number' && Number.isFinite(provider) && provider > 0)
      return provider >= 0.995 ? 'The wallet that added this coin\'s launch liquidity took all of it out of the pool.' : `The wallet that added this coin's launch liquidity took ${Math.round(provider * 1000) / 10}% of it out of the pool.`;
    const share = match.evidence.find((e) => e.kind === 'stat' && e.label === 'Removable deployer/crew LP share')?.value;
    // A lock or burn of the position is not read, so the reason says who added the liquidity, not that it can be pulled.
    if (typeof share === 'number' && Number.isFinite(share) && share > 0)
      return `The deployer added ${Math.round(share * 1000) / 10}% of this coin's pool liquidity${match.level === 'danger' ? ' and removed liquidity from an earlier launch' : ''}; EKO does not check whether it is locked.`;
  }
  if (match.id === 'malicious_hook') {
    const bits = match.evidence.find((e) => e.kind === 'stat' && e.label === 'Return-delta permission bits')?.value;
    const gap = match.evidence.find((e) => e.kind === 'stat' && e.label === 'Quote versus simulation gap (%)')?.value;
    // Permissions alone (no measured quote or fee anomaly): say what the hook may do, not that it does it.
    if (match.level === 'monitor' && typeof bits === 'number' && bits !== 0 && typeof gap !== 'number')
      return 'This coin trades in a pool whose hook may change what a swap pays or receives; EKO has not reviewed the hook.';
  }
  if (match.id === 'serial_deployer' && match.level === 'danger') {
    for (const relation of ['deployer', 'crew'] as const) for (const outcome of ['rugged', 'honeypot', 'dumped'] as const) {
      const count = match.evidence.find((e) => e.kind === 'stat' && e.label === `Earlier ${relation} launches ${outcome}`)?.value;
      if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 3) {
        const subject = relation === 'deployer' ? 'this deployer' : 'this crew';
        return outcome === 'honeypot' ? `${count} earlier launches by ${subject} ended as honeypots.` : outcome === 'rugged' ? `${count} earlier launches by ${subject} were rugged.` : `${count} earlier launches by ${subject} dumped.`;
      }
    }
  }
  return templates[match.id];
}

/**
 * Choose danger over monitor over clear and emit up to three deduplicated reasons ordered by
 * severity then id, retaining supplied metadata/matches. Pure rule-consumer call without auth;
 * assumes typed evidence, does not prove completeness or validate schema, and malformed input can
 * throw.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export function assembleVerdict(matches: PlaybookMatch[], meta: VerdictMeta): Verdict {
  const level = matches.some((m) => m.level === 'danger') ? 'danger' : matches.some((m) => m.level === 'monitor') ? 'monitor' : 'clear';
  // TODO(spec): reason ordering is unspecified; severity first, then stable
  // playbook id, deduplicated to three. No beta is emitted before the swarm.
  const ordered = [...matches].sort((a, b) => rank[b.level] - rank[a.level] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...meta, level, reasons: [...new Set(ordered.map(reasonForMatch))].slice(0, 3), playbooks: matches,
    schemaVersion: 'verdict-1' };
}

/**
 * The context line for an older coin that simply trades little (readMarketCap `quiet`): not a finding, so no match
 * carries it; the caller adds it to the verdict's reasons. Null for any other reading.
 */
export function marketCapContext(s: CardSources, cfg: PlaybookConfig['fake_mcap'] = CONFIG_V1.fake_mcap): string | null {
  const read = readMarketCap(s, cfg), m = s.marketCap;
  if (read?.kind !== 'quiet' || !m) return null;
  const hour = m.volume1hUsd == null ? null : m.volume1hUsd < 0.5 ? 'nothing traded in the last hour' : `${compactUsd(m.volume1hUsd)} traded in the last hour`;
  const buyers = m.buyers24h == null ? null : `${m.buyers24h} buyer${m.buyers24h === 1 ? '' : 's'} in 24 hours`;
  return [`Quiet: ${ageWords(read.ageSec)} old`, hour, buyers, `${compactUsd(m.backingUsd)} in its pool (${sharePct(read.backingShare)} of its ${compactUsd(m.mcapUsd)} market cap).`]
    .filter(Boolean).join(' · ');
}

/**
 * Why a verdict rests on part of a coin's history: EKO holds its trades and transfers only from `sinceSec`, so the
 * checks that read holders and early buyers did not run.
 */
export function partialHistoryReason(createdAtSec: number, sinceSec: number): string {
  const gap = Math.max(0, sinceSec - createdAtSec);
  return `EKO started following this coin ${gap < 14 * 86_400 ? ageWords(gap) : `${Math.round(gap / 86_400)} days`} after launch: holders and early buyers are not counted.`;
}
