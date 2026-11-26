import { useCallback, useState } from 'react';
import { parsePresets, type AmountUnit, type BuyPresets } from './tradePanelModel';

/**
 * The trader's own panel settings, kept in this browser only (a private window starts from the defaults): the buy
 * unit (the native coin, or dollars), the buy presets, and Quick buy (off unless turned on).
 */
const KEYS = { unit: 'eko.trade.unit', presets: 'eko.trade.presets.v1', quick: 'eko.trade.quick' } as const;
function get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function put(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* not kept: the panel still works */ } }

export const loadUnit = (): AmountUnit => get(KEYS.unit) === 'usd' ? 'usd' : 'native';
export const loadQuick = () => get(KEYS.quick) === '1';
export function loadPresets(): BuyPresets { try { return parsePresets(JSON.parse(get(KEYS.presets) ?? 'null')); } catch { return parsePresets(null); } }

export function useTradePrefs() {
  const [unit, setUnitState] = useState(loadUnit), [quick, setQuickState] = useState(loadQuick), [presets, setPresetsState] = useState(loadPresets);
  const setUnit = useCallback((u: AmountUnit) => { setUnitState(u); put(KEYS.unit, u); }, []);
  const setQuick = useCallback((on: boolean) => { setQuickState(on); put(KEYS.quick, on ? '1' : '0'); }, []);
  const setPresets = useCallback((p: BuyPresets) => { const checked = parsePresets(p); setPresetsState(checked); put(KEYS.presets, JSON.stringify(checked)); }, []);
  return { unit, setUnit, quick, setQuick, presets, setPresets };
}
