import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toEventSelector, type Abi, type AbiEvent } from 'viem';

const abi = JSON.parse(readFileSync(new URL('../abi/eko/ReceiptsRegistry.json', import.meta.url), 'utf8')) as Abi;

describe('Foundry ReceiptsRegistry ABI', () => {
  it.each([
    ['BatchCommitted', 'BatchCommitted(uint64,bytes32,uint32,address)', [true, true, false, true]],
    ['CommitterChanged', 'CommitterChanged(address,address)', [true, true]],
  ] as const)('derives the %s topic from the built ABI', (name, signature, indexed) => {
    const event = abi.find((entry): entry is AbiEvent => entry.type === 'event' && entry.name === name);
    expect(event).toBeDefined();
    expect(toEventSelector(event!)).toBe(toEventSelector(signature));
    expect(event!.inputs.map(input => input.indexed ?? false)).toEqual(indexed);
  });
});
