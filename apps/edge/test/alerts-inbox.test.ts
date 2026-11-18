import { describe, expect, it } from 'vitest';
import type { Alert } from '@eko/shared';
import { AlertInbox } from '../src/alerts.js';

const alert = (id: string): Alert => ({ id, ts: '2026-11-18T00:00:00.000Z', kind: 'order', title: 'Order filled', body: 'Demo order.', read: false });

describe('alert inbox', () => {
  it('keeps each account its own alerts, pages after a sequence number, and delivers as it posts', () => {
    const delivered: string[] = [], inbox = new AlertInbox({ perAccount: 2, accounts: 2 });
    inbox.deliver = (account, a) => delivered.push(`${account}:${a.id}`);
    inbox.post('demo-a', alert('1'));
    const two = inbox.post('demo-a', alert('2'));
    inbox.post('demo-a', alert('3'));
    inbox.post('demo-b', alert('4'));
    expect(delivered).toEqual(['demo-a:1', 'demo-a:2', 'demo-a:3', 'demo-b:4']);
    // At most perAccount each, oldest first.
    expect(inbox.page('demo-a').rows.map(a => a.id)).toEqual(['2', '3']);
    expect(inbox.page('demo-a', two).rows.map(a => a.id)).toEqual(['3']);
    expect(inbox.page('demo-b')).toEqual({ rows: [alert('4')], cursor: null, seq: 4 });
    // At most `accounts` accounts: the one alerted longest ago is forgotten.
    inbox.post('demo-c', alert('5'));
    expect(inbox.page('demo-a').rows).toEqual([]);
    inbox.erase('demo-b');
    expect(inbox.page('demo-b', 3)).toEqual({ rows: [], cursor: null, seq: 3 });
  });
});
