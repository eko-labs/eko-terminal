import { CHAIN_KEY } from '../../lib/chain';
import { hashedAddress, hashedTx } from './addresses';
import { COIN_EPOCH } from './coin';
import { createRadarCard, createRadarRows } from './radar';

/**
 * One account of who holds each offline coin and what they did, from launch to now, as shares of supply and seconds
 * after launch. Every page about a coin in mock mode reads its wallets, buys and sells from here (positions.ts books
 * them in dollars), so a coin page tells one story: the deployer's buy, sells and what it holds; the launch's bundles
 * (with the passes between their wallets), copy traders, snipers and the rest of the first minute; later traders and the
 * top holders; and every dev and insider sell. It holds exactly what the coin card's Supply panel says: the deployer's
 * share, what bundles hold and what the top 10 hold.
 *
 * A few coins tell a set story (STORIES); every other coin's launch is drawn from a hash of its address, rougher for a
 * coin the verdict flags than for a clear one. Generated addresses only (no four-character run repeated, no character
 * four times in a row), deterministic per coin.
 */

/** The chain's launch window: the edge's sniper blocks and block time. */
export const LAUNCH_WINDOW = CHAIN_KEY === 'robinhood' ? { sniperBlocks: 35, blockTimeSec: 0.102 } : { sniperBlocks: 10, blockTimeSec: 0.098 };
const WINDOW_SEC = LAUNCH_WINDOW.sniperBlocks * LAUNCH_WINDOW.blockTimeSec;
/** Blocks after the launch block, for a time after launch. */
export const blockAfter = (sec: number) => Math.round(sec / LAUNCH_WINDOW.blockTimeSec);

/** A seeded generator (mulberry32 over an FNV-1a hash), so each coin reads the same every run. */
export function rng(seed: string) {
  let h = 0x811c9dc5;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Hex that reads as typed in rather than generated: a character four times in a row, or a four-character run seen twice. */
export function looksTyped(hex: string): boolean {
  const h = hex.replace(/^0x/, '').toLowerCase();
  if (/(.)\1{3}/.test(h)) return true;
  for (let i = 0; i + 4 <= h.length; i++) if (h.indexOf(h.slice(i, i + 4), i + 1) >= 0) return true;
  return false;
}
/** A generated wallet address that does not read as typed in. */
export function ledgerAddress(seed: string): string {
  for (let n = 0; ; n++) { const a = hashedAddress(n ? `${seed}#${n}` : seed); if (!looksTyped(a)) return a; }
}
/** A generated transaction hash, likewise. */
export function ledgerTx(seed: string): string {
  for (let n = 0; ; n++) { const t = hashedTx(n ? `${seed}#${n}` : seed); if (!looksTyped(t)) return t; }
}

export type LedgerRole = 'dev' | 'linked' | 'bundle' | 'sniper';
export type LedgerKind = 'deployer' | 'bundle' | 'copy' | 'sniper' | 'early' | 'later';
/** A buy, a sell or tokens sent to the wallet; a `pass` is a bundle wallet's sell straight into another of its wallets. */
export interface LedgerEvent { sec: number; kind: 'buy' | 'sell' | 'in'; pct: number; pass?: boolean }
export interface LedgerWallet {
  wallet: string; group: string; kind: LedgerKind; roles: LedgerRole[];
  via: 'launch' | 'bought' | 'rotation' | 'received'; from?: string;
  /** In time order. */
  events: LedgerEvent[];
  boughtPct: number; soldPct: number; receivedPct: number; heldPct: number;
  firstBuySec: number | null; lastSellSec: number | null;
}
export interface LedgerGroup {
  id: string; kind: Exclude<LedgerKind, 'later'>; wallets: LedgerWallet[];
  /** For a bundle: what its launch wallets bought, what it sold (not its passes) and what its wallets hold. */
  boughtPct: number; soldPct: number; heldPct: number; lastSellSec: number | null;
  oneTx?: { sec: number; wallets: number }; launchWallets?: number;
  rotations?: { sec: number; from: string; to: string; pct: number }[];
  /** Copy traders: the bot they traded through. */
  bot?: string;
}
/** A sell by the deployer or an insider: its share of supply, of what the wallet held, and what it holds after. */
export interface LedgerSell { wallet: string; roles: LedgerRole[]; sec: number; pct: number; ofBag: number; heldAfterPct: number }
export interface CoinLedger {
  coin: string; symbol: string; deployer: string;
  /** Seconds since launch, and the launch time (unix seconds). */
  ageSec: number; launchTs: number;
  /** The launch: deployer, bundles, copy traders, snipers, the rest of the first minute (the launch map's lanes). */
  groups: LedgerGroup[];
  /** Every wallet that holds or held the coin. */
  wallets: LedgerWallet[];
  dev: { wallet: string; boughtPct: number; soldPct: number; heldPct: number; sells: { sec: number; pct: number }[] };
  bundlesHeldPct: number;
  /** The ten largest holders now, largest first. */
  top10: { wallet: string; pct: number }[]; top10Pct: number;
  /** Launch buyers one fresh wallet paid hours before launch. */
  funded: { funder: string; wallets: string[]; hoursBefore: number[] };
  /** Dev and insider sells (not passes between a bundle's own wallets), oldest first. */
  sells: LedgerSell[];
}

// ─── Stories ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Times are seconds after launch; a negative time is seconds before now. Shares are percent of supply. */
interface BundleSpec { at: number; launch: number[]; oneTx: boolean; passes: [at: number, from: number, share: number][]; sells: [at: number, wallet: number, amount: number][] }
/** Separate buyers: how many, between which seconds, what they bought and still hold, and their last sell. */
interface CrowdSpec { wallets: number; from: number; to: number; bought: number; held: number; lastSell: number }
/** One wallet's buy at launch and its sells. */
interface BagSpec { bought: number; sells: [at: number, pct: number][] }
interface Story {
  /** The deployer's sells; it bought what it holds now (the card's share) plus what it sold. */
  devSells: [at: number, pct: number][];
  bundles: BundleSpec[]; copy: CrowdSpec[]; snipers: CrowdSpec; early: CrowdSpec;
  /** A wallet the deployer paid, buying in the launch blocks. */
  linked: BagSpec;
  /** Snipers with a set story of their own. */
  sniperBags?: BagSpec[];
}

const STORIES: Record<string, Partial<Story>> = {
  // The real NYMO launch on Robinhood Chain: two wallets bought 22.2% in one transaction a block after launch, passed it
  // through 13 fresh wallets and sold all of it within 92 s, while copy traders followed through three bots; a second,
  // smaller bundle still holds 3.1%. The deployer sold 89% of its bag in two sells within 7 minutes.
  FROG: {
    devSells: [[214, 1.4], [417, 1.8]],
    bundles: [
      { at: 0.1, launch: [12.4, 9.8], oneTx: true,
        passes: [[4.0, 1, 0.3], [4.0, 0, 0.17], [4.4, 0, 0.15], [4.4, 1, 0.22], [4.8, 0, 0.45], [5.0, 1, 0.68], [5.2, 0, 0.6], [5.7, 7, 0.5],
          [21.2, 3, 1], [36.3, 6, 1], [51.5, 5, 1], [66.8, 2, 1], [82.7, 4, 1]],
        sells: [[5.2, 1, 99], [5.4, 0, 99], [6.1, 7, 99], [9.6, 8, 99], [14.3, 9, 99], [44.0, 10, 99], [58.9, 11, 99], [73.0, 12, 99], [88.4, 13, 99], [92.0, 14, 99]] },
      { at: 0.3, launch: [1.6, 1.5, 1.3], oneTx: true, passes: [], sells: [[141, 0, 0.6], [236, 2, 0.7]] },
    ],
    copy: [{ wallets: 11, from: 0.4, to: 2.3, bought: 10.8, held: 0.9, lastSell: 84 }, { wallets: 8, from: 1.6, to: 1.6, bought: 6.9, held: 0, lastSell: 57 },
      { wallets: 4, from: 2.2, to: 2.5, bought: 0.6, held: 0, lastSell: 128 }],
    snipers: { wallets: 21, from: 0.4, to: 3.5, bought: 24.6, held: 4.2, lastSell: 131 },
    early: { wallets: 26, from: 3.7, to: 58, bought: 9.1, held: 1.1, lastSell: 1820 },
    linked: { bought: 0.8, sells: [[190, 0.8]] },
  },
  // Four wallets bought 27.5% in the launch block, spread it over ten wallets and still hold 22%; the deployer holds.
  PLUM: {
    devSells: [],
    bundles: [{ at: 0, launch: [8.1, 7.4, 6.9, 5.1], oneTx: true,
      passes: [[3.1, 0, 0.5], [3.1, 1, 0.5], [12.6, 2, 0.4], [47.0, 4, 0.5], [95, 3, 0.6], [310, 5, 0.5]],
      sells: [[205, 0, 2.0], [412, 6, 1.9], [960, 8, 1.6]] }],
    copy: [{ wallets: 6, from: 1.2, to: 2.9, bought: 3.2, held: 0.4, lastSell: 260 }],
    snipers: { wallets: 9, from: 0.3, to: 3.4, bought: 11.4, held: 2.8, lastSell: 715 },
    early: { wallets: 14, from: 3.9, to: 57, bought: 6.3, held: 1.9, lastSell: 2400 },
  },
  // Three wallets bought 18.4%, spread it over eight and still hold 16%; the deployer sold a little after 21 minutes.
  GHOST: {
    devSells: [[1260, 0.8]],
    bundles: [{ at: 0.2, launch: [7.3, 6.2, 4.9], oneTx: true,
      passes: [[8.4, 0, 0.5], [8.4, 1, 0.4], [26, 2, 0.5], [71, 3, 0.5], [180, 5, 1]],
      sells: [[300, 4, 1.1], [540, 6, 1.3]] }],
    copy: [{ wallets: 7, from: 0.8, to: 2.6, bought: 5.4, held: 0.6, lastSell: 342 }, { wallets: 5, from: 2.0, to: 2.1, bought: 2.1, held: 0, lastSell: 96 }],
    snipers: { wallets: 12, from: 0.2, to: 3.3, bought: 13.2, held: 3.4, lastSell: 610 },
    early: { wallets: 19, from: 3.6, to: 59, bought: 7.7, held: 2.6, lastSell: 3100 },
  },
  // Recent dev and insider sells, the latest a few minutes ago.
  WREN: { devSells: [[-180, 8.4]] },                                   // the dev sold 42% of its bag; still holds 11.6%
  FERN: { sniperBags: [{ bought: 3.4 / 0.81, sells: [[-468, 3.4]] }, { bought: 2.6 / 0.68, sells: [[-420, 2.6]] }] }, // two snipers, 48 s apart
  TORCH: { devSells: [[-720, 2.7]] },                                  // the dev trimmed 18% of its bag; holds 12.3%
  REEF: { bundles: [{ at: 0.2, launch: [2.1, 1.9, 1.5, 1.6, 1.5, 1.4], oneTx: false, passes: [],    // three bundle wallets sold out in 95 s
    sells: [[-1175, 3, 99], [-1141, 4, 99], [-1080, 5, 99]] }] },
  ONYX: { linked: { bought: 2.2 / 0.64, sells: [[-1560, 2.2]] } },     // a wallet the dev paid sold 64% of its bag
  BLOOM: { devSells: [[-2100, 9.5]] },                                 // the dev sold everything
};

/** Any other coin: a launch drawn from its address, rougher when its verdict flags it. */
function drawnStory(key: string, bundleHeld: number, verdict: string): Story {
  const r = rng(`${key}:launch`), rough = verdict === 'danger' ? 1 : verdict === 'monitor' ? 0.7 : 0.35;
  const n = 2 + Math.floor(r() * 3), sold = bundleHeld * (0.15 + r() * 0.6 * rough), bought = bundleHeld + sold;
  const shares = Array.from({ length: n }, () => 0.6 + r()), sum = shares.reduce((a, b) => a + b, 0);
  const passes: BundleSpec['passes'] = Array.from({ length: Math.floor(r() * 4) }, (_, i) => [6 + i * (8 + r() * 30), i % n, 0.3 + r() * 0.4]);
  const crowd = (wallets: number, from: number, to: number, b: number, held: number, lastSell: number): CrowdSpec => ({ wallets, from, to, bought: b, held: Math.min(held, b), lastSell });
  const bots = r() < 0.6 ? 1 : 2;
  // Devs of clear coins mostly have not sold; the rest sold a little, once to three times.
  const neverSold = r() < (verdict === 'clear' ? 0.6 : verdict === 'monitor' ? 0.3 : 0.15), devSold = 0.3 + r() * 1.5 * rough, times = 1 + Math.floor(r() * 3);
  // A flagged coin's dev sells within the first hour; on the others, later.
  const firstSell = verdict === 'danger' ? 300 + Math.round(r() * 2400) : 3900 + Math.round(r() * 6000);
  const devSells: Story['devSells'] = neverSold ? [] : Array.from({ length: times }, (_, i) => [firstSell + i * 900, devSold / times]);
  const sniperBought = (3 + r() * 12) * (0.5 + rough * 0.5), sniperHeld = Math.min(sniperBought, (1 + r() * 4) * (1.4 - rough * 0.6));
  return {
    devSells,
    bundles: bundleHeld > 0 ? [{ at: Math.round(r() * 3) * LAUNCH_WINDOW.blockTimeSec, launch: shares.map(s => (s / sum) * bought), oneTx: true, passes, sells: [[150 + Math.round(r() * 900), 0, sold]] }] : [],
    copy: Array.from({ length: bots }, (_, i) => crowd(4 + Math.floor(r() * 8), 0.5 + i, 2.2 + i * 0.6, (2 + r() * 6) * (0.5 + rough * 0.5), r() * 1.2, 90 + Math.round(r() * 400))),
    snipers: crowd(4 + Math.floor(r() * 10), 0.2, 3.3, sniperBought, sniperHeld, 300 + Math.round(r() * 900)),
    early: crowd(8 + Math.floor(r() * 16), 3.8, 58, 3 + r() * 7, 0.5 + r() * 2.5, 900 + Math.round(r() * 4000)),
    linked: { bought: 0.3 + r() * 0.7, sells: r() < 0.5 * rough ? [[400 + Math.round(r() * 1500), 0.2 + r() * 0.2]] : [] },
  };
}

// ─── The ledger ──────────────────────────────────────────────────────────────────────────────────────────────────────

const ORDER = { buy: 0, in: 1, sell: 2 } as const;
/** Totals from a wallet's events. */
function settle(w: LedgerWallet): LedgerWallet {
  w.events.sort((a, b) => a.sec - b.sec || ORDER[a.kind] - ORDER[b.kind]);
  let bought = 0, sold = 0, received = 0, first: number | null = null, last: number | null = null;
  for (const e of w.events) {
    if (e.kind === 'buy') { bought += e.pct; first ??= e.sec; }
    else if (e.kind === 'in') received += e.pct;
    else { sold += e.pct; last = e.sec; }
  }
  const held = bought + received - sold;
  return Object.assign(w, { boughtPct: bought, soldPct: sold, receivedPct: received, heldPct: held < 1e-9 ? 0 : held, firstBuySec: first, lastSellSec: last });
}

const memo = new Map<string, CoinLedger>();

export function coinLedger(address: string): CoinLedger | undefined {
  const key = address.toLowerCase(), hit = memo.get(key);
  if (hit) return hit;
  const card = createRadarCard(address), row = createRadarRows().find(r => r.address.toLowerCase() === key);
  if (!card || !row) return undefined;
  const symbol = card.identity.symbol.text, deployer = card.identity.deployer;
  const ageSec = Math.max(600, row.ageSec ?? 3600), end = ageSec - 20, launchTs = COIN_EPOCH - ageSec;
  /** A story's time: seconds after launch, or (negative) before now; never after now. */
  const at = (sec: number) => Math.max(0, Math.min(sec < 0 ? ageSec + sec : sec, end));
  const seed = (label: string) => rng(`${key}:${label}`)();
  const addr = (label: string) => ledgerAddress(`${key}:${label}`);

  const drawn = drawnStory(key, card.supply.bundlesHeldPct, row.verdict), set = STORIES[symbol] ?? {};
  const story: Story = { ...drawn, ...set };
  const fit = (s: CrowdSpec): CrowdSpec => ({ ...s, from: Math.min(s.from, WINDOW_SEC * 0.5), to: Math.min(s.to, WINDOW_SEC * 0.95), lastSell: Math.min(s.lastSell, end * 0.9) });

  const wallets: LedgerWallet[] = [], groups: LedgerGroup[] = [];
  const make = (wallet: string, group: string, kind: LedgerKind, roles: LedgerRole[], via: LedgerWallet['via'], events: LedgerEvent[], from?: string): LedgerWallet => {
    const w: LedgerWallet = { wallet, group, kind, roles, via, ...(from ? { from } : {}), events, boughtPct: 0, soldPct: 0, receivedPct: 0, heldPct: 0, firstBuySec: null, lastSellSec: null };
    wallets.push(w);
    return w;
  };
  const group = (id: string, kind: LedgerGroup['kind'], members: LedgerWallet[], extra: Partial<LedgerGroup> = {}): LedgerGroup => {
    members.forEach(settle);
    const sum = (k: 'boughtPct' | 'soldPct' | 'heldPct') => members.reduce((n, w) => n + w[k], 0);
    const last = members.reduce<number | null>((m, w) => w.lastSellSec === null ? m : Math.max(m ?? 0, w.lastSellSec), null);
    const g: LedgerGroup = { id, kind, wallets: members, boughtPct: sum('boughtPct'), soldPct: sum('soldPct'), heldPct: sum('heldPct'), lastSellSec: last, ...extra };
    groups.push(g);
    return g;
  };

  // The deployer: bought at launch what it holds now plus what it sold.
  const devSells = story.devSells.map(([t, pct]) => ({ sec: at(t), pct })).sort((a, b) => a.sec - b.sec);
  const devSold = devSells.reduce((n, s) => n + s.pct, 0), devHeld = card.supply.devPct;
  const dev = make(deployer, 'deployer', 'deployer', ['dev'], 'launch', [{ sec: 0, kind: 'buy', pct: devHeld + devSold }, ...devSells.map(s => ({ sec: s.sec, kind: 'sell' as const, pct: s.pct }))]);
  group('deployer', 'deployer', [dev]);

  // Bundles: launch buys in one block (or one transaction), passes from wallet to fresh wallet, sells.
  story.bundles.forEach((spec, bi) => {
    const s = { ...spec, at: Math.min(spec.at, WINDOW_SEC * 0.3) }, id = `bundle-${bi + 1}`;
    const members = s.launch.map((b, i) => make(addr(`bundle${bi}:${i}`), id, 'bundle', ['bundle', 'sniper'], 'launch', [{ sec: s.at, kind: 'buy', pct: b }]));
    const holding = members.map(w => w.events[0]!.pct);
    const rotations: NonNullable<LedgerGroup['rotations']> = [];
    let sold = 0, lastSell: number | null = null;
    const events = [...s.passes.map(p => ({ t: at(p[0]), pass: p })), ...s.sells.map(x => ({ t: at(x[0]), sell: x }))].sort((a, b) => a.t - b.t);
    for (const e of events) {
      if ('pass' in e && e.pass) {
        const [, from, share] = e.pass, src = members[from]!, amount = holding[from]! * share;
        if (amount <= 1e-9) continue;
        holding[from] = holding[from]! - amount; src.events.push({ sec: e.t, kind: 'sell', pct: amount, pass: true });
        const to = make(addr(`bundle${bi}:${members.length}`), id, 'bundle', ['bundle'], 'rotation', [{ sec: e.t, kind: 'buy', pct: amount }], src.wallet);
        members.push(to); holding.push(amount);
        rotations.push({ sec: e.t, from: src.wallet, to: to.wallet, pct: amount });
      } else if ('sell' in e && e.sell) {
        // The named wallet sells first; what it does not hold comes from the bundle's largest holders (all of it at 99).
        const [, i, want] = e.sell;
        let left = want;
        const order = [i, ...members.map((_, k) => k).filter(k => k !== i).sort((a, b) => holding[b]! - holding[a]!)];
        for (const k of order) {
          if (left <= 1e-9 || (k !== i && want >= 99)) break;
          const amount = Math.min(left, holding[k]!);
          if (amount <= 1e-9) continue;
          holding[k] = holding[k]! - amount; members[k]!.events.push({ sec: e.t, kind: 'sell', pct: amount });
          sold += amount; left -= amount; lastSell = Math.max(lastSell ?? 0, e.t);
        }
      }
    }
    const g = group(id, 'bundle', members, { launchWallets: s.launch.length, rotations, ...(s.oneTx ? { oneTx: { sec: s.at, wallets: s.launch.length } } : {}) });
    Object.assign(g, { boughtPct: s.launch.reduce((a, b) => a + b, 0), soldPct: sold, lastSellSec: lastSell });
  });

  // Separate buyers: shares that vary, the holders among the larger buyers, sells spread up to the group's last sell.
  const crowd = (label: string, id: string, kind: LedgerKind, roles: LedgerRole[], via: LedgerWallet['via'], s: CrowdSpec): LedgerWallet[] => {
    const r = rng(`${key}:${label}`), weights = Array.from({ length: s.wallets }, (_, i) => (0.25 + r()) * (1 + (i < 3 ? 1.5 : 0))), total = weights.reduce((a, b) => a + b, 0);
    const rows = weights.map((w, i) => {
      const bought = (w / total) * s.bought, t = s.from + (s.wallets > 1 ? (s.to - s.from) * (i / (s.wallets - 1)) * (0.85 + r() * 0.15) : 0);
      return { wallet: addr(`${label}:${i}`), t, bought, held: 0, sold: bought, lastSell: 0 };
    });
    let left = s.held;
    for (const w of [...rows].sort((a, b) => b.bought - a.bought)) { if (left <= 1e-9) break; const keep = Math.min(w.bought * (0.5 + r() * 0.5), left); w.held = keep; w.sold = w.bought - keep; left -= keep; }
    rows.filter(w => w.sold > 1e-9).forEach((w, i) => { w.lastSell = i === 0 ? s.lastSell : Math.max(w.t + 2, s.lastSell * (0.2 + r() * 0.75)); });
    return rows.map(w => make(w.wallet, id, kind, roles, via, [{ sec: w.t, kind: 'buy', pct: w.bought }, ...(w.sold > 1e-9 ? [{ sec: Math.min(w.lastSell, end), kind: 'sell' as const, pct: w.sold }] : [])]));
  };
  story.copy.forEach((s, i) => group(`copy-${i + 1}`, 'copy', crowd(`copy${i}`, `copy-${i + 1}`, 'copy', ['sniper'], 'launch', fit(s)), { bot: addr(`bot${i}`) }));
  const bag = (label: string, roles: LedgerRole[], b: BagSpec, sec: number) =>
    make(addr(label), 'snipers', 'sniper', roles, 'launch', [{ sec, kind: 'buy', pct: b.bought }, ...b.sells.map(([t, pct]) => ({ sec: at(t), kind: 'sell' as const, pct }))]);
  const snipers = [bag('linked', ['linked', 'sniper'], story.linked, Math.round(WINDOW_SEC * 0.2 * 1000) / 1000),
    ...(story.sniperBags ?? []).map((b, i) => bag(`sniperbag${i}`, ['sniper'], b, Math.round(WINDOW_SEC * (0.1 + i * 0.15) * 1000) / 1000)),
    ...crowd('snipers', 'snipers', 'sniper', ['sniper'], 'launch', fit(story.snipers))];
  group('snipers', 'sniper', snipers);
  group('early', 'early', crowd('early', 'early', 'early', [], 'bought', { ...story.early, from: Math.max(story.early.from, WINDOW_SEC + 0.2), lastSell: Math.min(story.early.lastSell, end * 0.9) }));

  // The top 10 hold what the card says: the largest launch holders, and whales who bought later make up the rest.
  wallets.forEach(settle);
  const launchHeld = wallets.map(w => w.heldPct).sort((a, b) => b - a), T = card.supply.top10Pct;
  // As many launch holders as fit, with no later whale much over twice the top 10's average share.
  let k = 0;
  for (let j = 0; j < 10; j++) {
    const sumJ = launchHeld.slice(0, j).reduce((a, b) => a + b, 0), avg = (T - sumJ) / (10 - j);
    if (avg >= (launchHeld[j] ?? 0) * 1.12 + 0.05 && (j === 0 || avg <= T / 10 * 1.8)) k = j;
  }
  const sumK = launchHeld.slice(0, k).reduce((a, b) => a + b, 0), whaleCount = 10 - k, avg = whaleCount ? (T - sumK) / whaleCount : 0;
  const lo = (launchHeld[k] ?? 0) * 1.06 + 0.02, spread = [1.5, 1.3, 1.18, 1.08, 1, 0.93, 0.86, 0.8, 0.72, 0.63].slice(0, whaleCount);
  const mean = spread.reduce((a, b) => a + b, 0) / Math.max(1, spread.length), shares = spread.map(g => lo + (avg - lo) * g / mean);
  const sec = (r: number) => Math.round(20 + (end - 20) * r);
  shares.forEach((share, i) => {
    const part = seed(`wp${i}`) < 0.4 ? 0.15 + seed(`wq${i}`) * 0.35 : 0, t = sec(seed(`wt${i}`) ** 1.3), buy = share / (1 - part);
    make(addr(`holder${i}`), 'later', 'later', [], 'bought', [{ sec: t, kind: 'buy', pct: buy },
      ...(part ? [{ sec: Math.min(end, t + Math.round((end - t) * (0.3 + seed(`ws${i}`) * 0.6))), kind: 'sell' as const, pct: buy * part }] : [])]);
  });
  const topMin = Math.min(...(whaleCount ? shares : [Infinity]), ...(k ? [launchHeld[k - 1]!] : [Infinity])), cap = Math.min(topMin, Infinity) * 0.85;

  // Everyone else: buyers through the coin's life (more early on), some sold out, some sold part, a few bought twice;
  // none holding as much as the smallest of the top 10.
  const soFar = launchHeld.reduce((a, b) => a + b, 0) + shares.reduce((a, b) => a + b, 0);
  const target = Math.min(96, Math.max(soFar + 10, Math.min(85, Math.max(45, T + 30))));
  // More of them where each may hold only a little.
  const traders = Math.min(260, Math.max(90 + Math.floor(seed('count') * 40), Math.ceil((target - soFar) / (cap * 0.45))));
  const raw = Array.from({ length: traders }, (_, i) => 1 / (i + 2) ** 1.15 * (0.6 + seed(`w${i}`) * 0.8));
  const soldOut = raw.map((_, i) => seed(`o${i}`) < 0.22), holders = raw.filter((_, i) => !soldOut[i]).length;
  const room = Math.max(0.3, Math.min(target - soFar, holders * cap * 0.6));
  let held = raw.map((x, i) => soldOut[i] ? 0 : x), fixed = new Array<boolean>(traders).fill(false);
  for (let pass = 0; pass < 8; pass++) {
    const free = held.reduce((s, x, i) => s + (fixed[i] ? 0 : x), 0), want = room - held.reduce((s, x, i) => s + (fixed[i] ? x : 0), 0);
    held = held.map((x, i) => fixed[i] ? x : x * want / free);
    if (!held.some((x, i) => !fixed[i] && x > cap)) break;
    held = held.map((x, i) => { if (!fixed[i] && x > cap) { fixed[i] = true; return cap; } return x; });
  }
  const scale = room / raw.reduce((s, x, i) => s + (soldOut[i] ? 0 : x), 0);
  raw.forEach((w, i) => {
    const r = seed(`t${i}`), t = Math.round(20 + (end - 20) * r ** 1.7), part = soldOut[i] ? 1 : seed(`p${i}`) < 0.45 ? 0.2 + seed(`q${i}`) * 0.5 : 0;
    const tokens = soldOut[i] ? Math.min(w * scale * (0.5 + seed(`s${i}`)), cap) : held[i]! / (1 - part), twice = seed(`x${i}`) < 0.18;
    const sellSec = Math.min(end, t + Math.round((end - t) * (0.3 + seed(`y${i}`) * 0.7)));
    const events: LedgerEvent[] = twice
      ? [{ sec: t, kind: 'buy', pct: tokens * 0.6 }, { sec: Math.min(end, t + Math.round((end - t) * 0.25)), kind: 'buy', pct: tokens * 0.4 }]
      : [{ sec: t, kind: 'buy', pct: tokens }];
    if (part) events.push({ sec: Math.max(sellSec, events.at(-1)!.sec), kind: 'sell', pct: tokens * part });
    make(addr(`trader${i}`), 'later', 'later', [], 'bought', events);
  });
  // Three wallets that were only ever sent tokens (cost unknown).
  [1, 2, 3].forEach(n => make(addr(`received${n}`), 'later', 'later', [], 'received', [{ sec: sec(0.2 + n * 0.1), kind: 'in', pct: Math.min(0.15 + seed(`r${n}`) * 0.3, cap * 0.5) }]));
  wallets.forEach(settle);

  const top10 = [...wallets].filter(w => w.heldPct > 0).sort((a, b) => b.heldPct - a.heldPct).slice(0, 10).map(w => ({ wallet: w.wallet, pct: w.heldPct }));
  // Three of the launch's snipers were paid by one fresh wallet hours before launch.
  const plain = snipers.filter(w => w.roles.length === 1).slice(1, 4);
  const funded = { funder: addr('funder'), wallets: plain.map(w => w.wallet), hoursBefore: [3, 2.8, 3.1].slice(0, plain.length) };

  const sells: LedgerSell[] = [];
  for (const w of wallets) {
    if (!w.roles.length) continue;
    let bal = 0;
    for (const e of w.events) {
      if (e.kind !== 'sell') { bal += e.pct; continue; }
      const before = bal; bal -= e.pct;
      if (!e.pass) sells.push({ wallet: w.wallet, roles: w.roles, sec: e.sec, pct: e.pct, ofBag: before > 0 ? Math.min(1, e.pct / before) : 1, heldAfterPct: Math.max(0, bal < 1e-9 ? 0 : bal) });
    }
  }
  sells.sort((a, b) => a.sec - b.sec);

  const ledger: CoinLedger = { coin: card.identity.address, symbol, deployer, ageSec, launchTs, groups, wallets,
    dev: { wallet: deployer, boughtPct: dev.boughtPct, soldPct: dev.soldPct, heldPct: dev.heldPct, sells: devSells },
    bundlesHeldPct: groups.filter(g => g.kind === 'bundle').reduce((n, g) => n + g.heldPct, 0),
    top10, top10Pct: top10.reduce((n, t) => n + t.pct, 0), funded, sells };
  memo.set(key, ledger);
  return ledger;
}

/** Whether the deployer had sold by `sec` after launch, and what it sold by then (percent of supply). */
export function devSoldBy(l: CoinLedger, sec: number): number {
  return l.dev.sells.filter(s => s.sec <= sec).reduce((n, s) => n + s.pct, 0);
}
