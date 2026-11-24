import { describe, expect, it } from 'vitest';
import { uniqueKeys } from './keys';

describe('uniqueKeys', () => {
  it('keeps unique keys as they are and numbers repeats in order', () => {
    const rows = [{ tx: '0xa', side: 'buy' }, { tx: '0xb', side: 'buy' }, { tx: '0xa', side: 'buy' }, { tx: '0xa', side: 'sell' }, { tx: '0xa', side: 'buy' }];
    expect(uniqueKeys(rows, r => `${r.tx}:${r.side}`)).toEqual(['0xa:buy', '0xb:buy', '0xa:buy#2', '0xa:sell', '0xa:buy#3']);
  });
  it('gives a row the same key when newer rows are added in front', () => {
    const older = [{ tx: '0xa' }, { tx: '0xa' }], newer = [{ tx: '0xc' }, ...older];
    expect(uniqueKeys(newer, r => r.tx).slice(1)).toEqual(uniqueKeys(older, r => r.tx));
  });
});
