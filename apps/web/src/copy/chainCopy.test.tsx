import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { CHAIN_KEYS, type ChainKey } from '@eko/shared';
import { CHAIN_COPY_BY_CHAIN } from './chain';

vi.mock('../lib/useMedia', () => ({ useMedia: () => false }));

// Each build names only its own chain. Every chain-specific copy table is evaluated as that build ships it (modules
// re-imported with VITE_EKO_CHAIN stubbed), then searched for the other chain's names.
const OTHER_CHAIN: Record<ChainKey, RegExp> = {
  robinhood: /\bHYPE\b|WHYPE|Montra|Kinetiq|Hyperliquid|HyperEVM|Elysium|99901/i,
  elysium: /Robinhood|\bPons\b|\b4663\b|Blockscout/i,
};
/**
 * Labels for data values the server sends, not prose: both builds carry every launchpad and venue label, and a label
 * shows only when a quote or row names that venue. (On Elysium the Robinhood MCP connection screens are absent: their
 * copy is null there, so nothing is allowed for them.)
 */
const DATA_LABELS = new Set(['index.FEE_CURVE_ZERO', 'trade.TRADE_LABELS.venues.pons_curve']);
// Every copy module with chain wording, plus the glossary and the one-tap flow's error text.
const MODULES = {
  index: () => import('./index'), chain: () => import('./chain'), scan: () => import('./scan'), settings: () => import('./settings'),
  trade: () => import('./trade'), mission: () => import('./mission'), shell: () => import('./shell'), availability: () => import('./availability'),
  guard: () => import('./guard'), playbooks: () => import('./playbooks'), review: () => import('./review'), pwa: () => import('./pwa'),
  glossary: () => import('../components/onboarding/glossary'),
} as const;
async function shipped(key: ChainKey) {
  vi.resetModules(); vi.stubEnv('VITE_EKO_CHAIN', key);
  return Object.fromEntries(await Promise.all(Object.entries(MODULES).map(async ([name, load]) => [name, await load()] as const)));
}
/** Every string reachable from a value: object fields, array items and what functions return for sample arguments. */
function strings(value: unknown, path: string, out: [string, string][] = [], seen = new Set<unknown>()): [string, string][] {
  if (typeof value === 'string') out.push([path, value]);
  else if (typeof value === 'function') {
    try { strings(value(...Array.from({ length: Math.max(value.length, 2) }, () => 'sample')), `${path}()`, out, seen); } catch { /* needs real input */ }
  } else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out, seen);
  }
  return out;
}
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe.each(CHAIN_KEYS)('%s build copy', (key) => {
  it('names no other chain, launchpad or native coin in any chain-specific table', async () => {
    const modules = await shipped(key);
    // Only this build's table: CHAIN_COPY_BY_CHAIN deliberately holds both.
    const { CHAIN_COPY_BY_CHAIN: _both, ...chain } = modules.chain as Record<string, unknown>;
    const found = strings({ ...modules, chain }, '').map(([path, text]) => [path.slice(1), text] as const)
      .filter(([path, text]) => OTHER_CHAIN[key].test(text) && !DATA_LABELS.has(path));
    expect(found).toEqual([]);
  });
  it('picks this build’s table', async () => {
    const { chain } = await shipped(key) as { chain: typeof import('./chain') };
    expect(chain.CHAIN_COPY).toEqual(CHAIN_COPY_BY_CHAIN[key]);
    expect(chain.CHAIN_NAME).toBe(key === 'robinhood' ? 'Robinhood Chain' : 'Elysium');
  });
});

describe('per-chain tables', () => {
  it('cover the same surfaces on both chains, each naming only its own chain', () => {
    const shape = (k: ChainKey) => strings(CHAIN_COPY_BY_CHAIN[k], '').map(([path]) => path);
    expect(shape('robinhood')).toEqual(shape('elysium'));
    for (const k of CHAIN_KEYS) expect(strings(CHAIN_COPY_BY_CHAIN[k], '').filter(([, text]) => OTHER_CHAIN[k].test(text))).toEqual([]);
  });
  it('Elysium keeps its wording, and Robinhood Chain describes the Pons curve before the pool', () => {
    expect(CHAIN_COPY_BY_CHAIN.elysium.pairs.near_grad.about).toContain('16.8×');
    expect(CHAIN_COPY_BY_CHAIN.robinhood.pairs.near_grad.about).toMatch(/bonding curve.*Uniswap v4 pool with the Pons hook/);
    expect(CHAIN_COPY_BY_CHAIN.robinhood.padFilter).toEqual({ label: 'Pons', launchpad: 'pons' });
  });
});

describe('Robinhood MCP agent connection', () => {
  async function screens(key: ChainKey) {
    vi.resetModules(); vi.stubEnv('VITE_EKO_CHAIN', key);
    const [{ default: Connection }, { createMissionDemo }, mission] = await Promise.all([
      import('../pages/mission/Connection'), import('../mocks/demo/mission'), import('./mission')]);
    const demo = createMissionDemo(1790852400000), agent = demo.agents.find((a) => a.kind === 'robinhood_mcp')!;
    return { html: render(<Connection agent={agent} keys={demo.keys[agent.id] ?? []} flags={{}} onKeys={() => {}} />), mission };
  }
  it('shows the Robinhood connection, its labels and steps on Robinhood Chain', async () => {
    const { html, mission } = await screens('robinhood');
    expect(html).toContain('Robinhood connection'); expect(html).toContain('https://robinhood.com/account/settings');
    expect(mission.ROBINHOOD_MCP?.label).toBe('Robinhood (MCP)');
    expect(mission.CONNECT_STEPS.approvals).toBe('Check trade approvals are on in Robinhood');
    expect(mission.MISSION_TEXT.disconnected('Scout', true)).toContain('Open Robinhood to disconnect');
    expect(mission.POLICY_FIELDS.map((f) => f.key)).toContain('earningsBlackoutDays');
  });
  it('keeps Elysium’s screens as they are', async () => {
    const { html, mission } = await screens('elysium');
    expect(html).not.toMatch(/Robinhood/);
    expect(mission.ROBINHOOD_MCP).toBeNull();
    expect(mission.CONNECT_STEPS.approvals).toBe('Know what the checks can’t stop');
    expect(mission.MISSION_TEXT.disconnected('Scout', true)).toBe('Disconnected. Scout’s EKO keys are revoked.');
    expect(mission.POLICY_FIELDS.map((f) => f.key)).not.toContain('earningsBlackoutDays');
  });
});
