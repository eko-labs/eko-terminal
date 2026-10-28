import { afterEach, describe, expect, it, vi } from 'vitest';
const request = vi.fn();
vi.mock('./api', () => ({ api: (...args: unknown[]) => request(...args) }));
import { flushPendingReports } from './pendingReports';
afterEach(() => { vi.unstubAllGlobals(); request.mockReset(); });
describe('bounded reconnect reporting', () => {
  it('shares one in-flight recovery and uses the background request budget', async () => {
    let release!: () => void;
    const values = new Map([['eko.pendingTx', JSON.stringify({ 'demo-order': { txHash: 'demo-hash', at: Date.now() } })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
    request.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const first = flushPendingReports(), second = flushPendingReports(); expect(first).toBe(second);
    expect(request).toHaveBeenCalledOnce(); expect(request.mock.calls[0][1]).toEqual({ body: {txHash:'demo-hash'}, background:true });
    release(); await first; expect(JSON.parse(values.get('eko.pendingTx')!)).toEqual({});
  });
});
