import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ on: vi.fn(), connect: vi.fn(), query: vi.fn(), end: vi.fn(), construct: vi.fn() }));
vi.mock('pg', () => ({ default: { Client: class {
  constructor(options: unknown) { fixture.construct(options); }
  on = fixture.on; connect = fixture.connect; query = fixture.query; end = fixture.end;
} } }));
import { InProcessBus, PostgresBus } from '../src/bus.js';
beforeEach(() => vi.clearAllMocks());

describe('engine notification boundaries', () => {
  it('unsubscribes in-process listeners without affecting other subscribers', async () => {
    const bus = new InProcessBus(), a = vi.fn(), b = vi.fn();
    const unsubscribe = await bus.subscribe(a); await bus.subscribe(b);
    const message = { topic: 'chain_block' as const, ids: { block: 1 } };
    bus.publish(message); expect(a).toHaveBeenCalledWith(message); expect(b).toHaveBeenCalledWith(message);
    await unsubscribe(); await unsubscribe(); bus.publish(message);
    expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledTimes(2);
  });
  it('listens on known channels, refuses malformed notifications and closes its dedicated connection', async () => {
    const handler = vi.fn(), bus = new PostgresBus('postgres://demo.invalid/fixture');
    const unsubscribe = await bus.subscribe(handler);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.construct).toHaveBeenCalledWith({ connectionString: 'postgres://demo.invalid/fixture' });
    expect(fixture.query).toHaveBeenCalledWith('LISTEN eko_chain_block');
    expect(fixture.query).toHaveBeenCalledWith('LISTEN eko_guard_revision_invalidated');
    const notify = fixture.on.mock.calls.find(([event]) => event === 'notification')![1];
    for (const [channel, payload] of [
      ['unknown', '{}'], ['eko_swap', undefined], ['eko_swap', 'invalid-json'], ['eko_swap', 'null'],
      ['eko_swap', '[]'], ['eko_swap', '{"coin":{}}'], ['eko_guard_evidence_created', '{}'],
    ]) notify({ channel, payload });
    expect(handler).not.toHaveBeenCalled();
    notify({ channel: 'eko_chain_block', payload: '{"block":12,"hash":"fixture-hash"}' });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ topic: 'chain_block', ids: { block: 12, hash: 'fixture-hash' } });
    expect(() => fixture.on.mock.calls.find(([event]) => event === 'error')![1](new Error('fixture disconnect'))).not.toThrow();
    await unsubscribe(); expect(fixture.end).toHaveBeenCalledOnce();
  });
});
