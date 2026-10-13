import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ load: vi.fn(), construct: vi.fn(), warn: vi.fn() }));
vi.mock('@eko/chain', async () => ({ loadRegistry: mocks.load, withRpcOrigin: (await import('../../../packages/chain/src/rpc/origin.js')).withRpcOrigin }));
vi.mock('../src/obs/security-collectors.js', () => ({
  SecurityCollectors: class { constructor(...args: unknown[]) { mocks.construct(...args); } },
}));
vi.mock('../src/obs/logger.js', () => ({ logger: { warn: mocks.warn } }));
import { securityBudgetOpen, workerSecurityCollectors } from '../src/obs/security-worker.js';

const addr = (n: string) => `0x${n.repeat(40)}`;
const context = () => ({
  cfg: { APP_ROLE: 'worker', SECURITY_COLLECTORS: { gas: true }, RECEIPTS_REGISTRY_ADDRESS: addr('a').toUpperCase(),
    BURN_WALLET_ADDRESS: addr('b').toUpperCase(), DEV_FEE_WALLET: addr('c').toUpperCase() },
  dbh: { chain: {} }, chains: { get: vi.fn(() => ({ request: vi.fn(async () => 'fixture-result') })),
    meter: { isStopped: false, config: { dailyBudget: 1, sessionBudget: 1 } } },
  monitoring: { record: vi.fn(async () => {}) },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReturnValue({ addressOf: () => addr('a'), requireAddress: (name: string) => name === 'tokens.WETH' ? addr('d') : addr('e') });
});
describe('security collector worker wiring', () => {
  it('does not construct or read the registry when all collectors are disabled', () => {
    const ctx = context(); ctx.cfg.SECURITY_COLLECTORS.gas = false;
    expect(workerSecurityCollectors(ctx as never)).toBeUndefined();
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.construct).not.toHaveBeenCalled();
  });
  it('binds approved addresses, shared RPC, reporting and a dynamically enforced budget without starting polling', async () => {
    const ctx = context();
    expect(workerSecurityCollectors(ctx as never)).toBeDefined();
    const [db, rpc, config, bindings, record, unavailable, budget, diagnostic] = mocks.construct.mock.calls[0]!;
    expect(db).toBe(ctx.dbh.chain); expect(config).toBe(ctx.cfg.SECURITY_COLLECTORS);
    expect(bindings).toEqual({ registry: addr('a'), burn: addr('b'), published: [addr('c'), addr('b')], weth: addr('d'), usdg: addr('e') });
    expect(ctx.chains.get).toHaveBeenCalledExactlyOnceWith('robinhood-mainnet','worker.security_collectors');
    const client = ctx.chains.get.mock.results[0]!.value;
    expect(client.request).not.toHaveBeenCalled();
    expect(await rpc.request('eth_chainId', [])).toBe('fixture-result');
    expect(client.request).toHaveBeenCalledWith({ method: 'eth_chainId', params: [] });
    const measurement = { metric: 'receipt_committer_balance_eth', value: 1 };
    await record(measurement); expect(ctx.monitoring.record).toHaveBeenCalledWith(measurement);
    expect(budget()).toBe(true); ctx.chains.meter.isStopped = true; expect(budget()).toBe(false);
    unavailable('gas'); diagnostic();
    expect(mocks.warn.mock.calls).toEqual([[{ collector: 'gas' }, 'security_collector_unavailable'], ['security_wallet_unknown_token_observation']]);
  });
  it.each([undefined, addr('f')])('uses zero registry binding for unaccepted manifest %s', accepted => {
    mocks.load.mockReturnValue({ addressOf: () => accepted, requireAddress: () => addr('d') });
    workerSecurityCollectors(context() as never);
    expect(mocks.construct.mock.calls[0]![3].registry).toBe(addr('0'));
  });
  it('rejects incomplete registry wiring before constructing a collector', () => {
    mocks.load.mockReturnValue({ addressOf: () => addr('a'), requireAddress: () => { throw new Error('missing token'); } });
    expect(() => workerSecurityCollectors(context() as never)).toThrow('missing token');
    expect(mocks.construct).not.toHaveBeenCalled();
  });
  it.each([{ dailyBudget: 0, sessionBudget: 1 }, { dailyBudget: 1, sessionBudget: 0 }])('rejects zero budgets %j', config => {
    expect(securityBudgetOpen({ isStopped: false, config } as never)).toBe(false);
  });
});
