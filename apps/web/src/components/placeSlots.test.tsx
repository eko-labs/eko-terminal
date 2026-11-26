import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlaceSlots } from '../features';
import { HeaderSlots, activePlaceSlots } from './placeSlots';

const Control = () => null;
const features = [
  { flag: 'size_check' as const, places: { header: Control } satisfies PlaceSlots },
  { flag: 'quant' as const },
];

describe('places outside the coin page', () => {
  it('fills the top bar only while a feature that fills it is on', () => {
    expect(activePlaceSlots(features, undefined)).toEqual([]);
    expect(activePlaceSlots(features, { quant: true })).toEqual([]);
    expect(activePlaceSlots(features, { size_check: true })).toEqual([{ header: Control }]);
  });
  it('renders nothing in the top bar while no feature fills it', () => {
    expect(renderToStaticMarkup(<HeaderSlots />)).toBe('');
    expect(renderToStaticMarkup(<HeaderSlots compact />)).toBe('');
  });
});
