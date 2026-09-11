import { describe, expect, it } from 'vitest';
import { keccak256, stringToHex } from 'viem';
import { canonicalize, orderHash } from '../src/index.js';
import { ASSET, request } from './fixtures.js';

describe('RFC 8785 JCS (https://www.rfc-editor.org/rfc/rfc8785)', () => {
  it('reproduces the §3.2.2–3.2.4 serialization vector and UTF-8 bytes', () => {
    const input = { numbers: [333333333.33333329, 1E30, 4.50, 2e-3, 1e-27],
      string: "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"/", literals: [null, true, false] };
    const expected = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`;
    expect(canonicalize(input)).toBe(expected);
    expect(stringToHex(canonicalize(input))).toBe('0x7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c226e756d62657273223a5b3333333333333333332e333333333333332c31652b33302c342e352c302e3030322c31652d32375d2c22737472696e67223a22e282ac245c75303030665c6e4127425c225c5c5c5c5c222f227d');
  });
  it('reproduces the §3.2.3 UTF-16 property sort vector', () => {
    const input = { '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One', '\ud83d\ude00': 'Emoji: Grinning Face', '\u0080': 'Control', '\u00f6': 'Latin Small Letter O With Diaeresis' };
    expect(canonicalize(input)).toBe('{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}');
  });
  it.each([
    ['0000000000000000', '0'], ['8000000000000000', '0'], ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'], ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'], ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'], ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'], ['44b52d02c7e14af6', '1e+23'], ['44b52d02c7e14af7', '1.0000000000000001e+23'],
  ])('reproduces Appendix B binary64 %s → %s', (hex, expected) => {
    const bytes = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
    expect(canonicalize(new DataView(bytes.buffer).getFloat64(0))).toBe(expected);
  });
  it('sorts nested objects and numeric-looking keys without reordering arrays or normalizing Unicode', () => {
    expect(canonicalize({ z: [{ z: 2, a: 1 }, 0], a: { '2': 'two', '10': 'ten' } })).toBe('{"a":{"10":"ten","2":"two"},"z":[{"a":1,"z":2},0]}');
    expect(canonicalize('é')).not.toBe(canonicalize('e\u0301'));
    expect(canonicalize({ a: 1, b: { a: 1 } })).toBe('{"a":1,"b":{"a":1}}');
  });
  it.each([NaN, Infinity, -Infinity, '\uDEAD', '\uD800', { '\uDEAD': 1 }, { x: undefined },
    undefined, 1n, () => 1, Symbol('x'), new Date(0), [undefined], Array(1)])('rejects non-JSON input %#', (input) => {
    expect(() => canonicalize(input)).toThrow(TypeError);
  });
  it('rejects cycles but accepts repeated non-cyclic objects', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(/cycle/);
    const child = { z: 1 };
    expect(canonicalize([child, child])).toBe('[{"z":1},{"z":1}]');
  });
});

describe('order hashing', () => {
  it('hashes the UTF-8 JCS bytes with keccak256', () => {
    const expected = '{"instrument":"' + ASSET + '","notionalUsd":100,"orderType":"market","side":"buy","venue":"rhc"}';
    expect(orderHash(request.order)).toBe(keccak256(stringToHex(expected)));
    const reversed = Object.fromEntries(Object.entries(request.order).reverse()) as typeof request.order;
    expect(orderHash(reversed)).toBe(orderHash(request.order));
    expect(orderHash({ ...request.order, qty: undefined })).toBe(orderHash(request.order));
  });
  it('binds all order fields and transaction calldata', () => {
    const tx = { to: ASSET as `0x${string}`, data: '0x1234' as const, value: '0' };
    const order = { ...request.order, tx };
    for (const changed of [{ ...order, tx: { ...tx, data: '0x5678' as const } }, { ...order, tx: { ...tx, value: '1' } },
      { ...order, tx: { ...tx, to: '0x1111111111111111111111111111111111111111' as const } },
      { ...order, notionalUsd: 101 }, { ...order, side: 'sell' as const }, { ...order, qty: 10 },
      { ...order, orderType: 'limit' as const }, { ...order, limitPrice: 10 }, { ...order, venue: 'base' as const },
      { ...order, leverage: 2 }, { ...order, instrument: 'other' }]) {
      expect(orderHash(changed)).not.toBe(orderHash(order));
    }
    expect(orderHash({ ...order, tx: { value: '0', data: '0x1234', to: tx.to } })).toBe(orderHash(order));
    expect(orderHash(order)).not.toBe(orderHash(request.order));
  });
});
