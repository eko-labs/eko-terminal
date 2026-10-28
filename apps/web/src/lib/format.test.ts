import { describe, expect, it } from 'vitest';
import { formatAge, formatCoinPrice, formatFeedSize, formatUsd, formatUtcTime } from './format';

describe('terminal age format', () => {
  it.each([
    [-1, '0s'], [0, '0s'], [8, '8s'], [59.9, '59s'], [60, '1m'], [21 * 60, '21m'],
    [3599, '59m'], [3600, '1h 0m'], [3840, '1h 4m'], [41280, '11h 28m'],
    [86399, '23h 59m'], [86400, '1d'], [29.7 * 3600, '1d'], [172800, '2d'],
  ])('formats %s seconds as %s', (seconds, text) => expect(formatAge(seconds)).toBe(text));
});
describe('feed sizes', () => {
  it.each([[25, '$25'], [999, '$999'], [1000, '$1.0K'], [3999, '$4.0K'], [12850, '$12.8K'], [1000000, '$1.00M']])('formats %s as %s', (value, text) => expect(formatFeedSize(value)).toBe(text));
});

describe('prototype coin prices', () => {
  it.each([
    [0, '$0.00'], [.0032176, '$0.00322'], [.003173, '$0.00317'], [.003239, '$0.00324'],
    [.003311, '$0.00331'], [.000032176, '$0.0000322'], [.009999, '$0.0100'],
    [.01, '$0.01000'], [.127891, '$0.12789'], [1, '$1.0000'], [123.456789, '$123.4568'],
    [NaN, '—'], [Infinity, '—'],
  ])('formats %s as %s', (value, text) => expect(formatCoinPrice(value)).toBe(text));
});

describe('exact USD and UTC display', () => {
  it.each([
    ['95', '$95.00'], ['5.005', '$5.00'], ['5.015', '$5.02'], ['5.0051', '$5.01'],
    ['-12.5', '-$12.50'], ['12345678901234567890.12', '$12,345,678,901,234,567,890.12'],
  ])('formats %s without floating point loss as %s', (value, text) => expect(formatUsd(value)).toBe(text));
  it('formats whole reference sizes and invalid amounts', () => {
    expect(formatUsd(1000, 0)).toBe('$1,000');
    expect(formatUsd(NaN)).toBe('—');
  });
  it('formats snapshot seconds as UTC independently of local timezone', () => {
    expect(formatUtcTime('1000')).toBe('1970-01-01 00:16:40 UTC');
    expect(formatUtcTime('invalid')).toBe('—');
  });
});
