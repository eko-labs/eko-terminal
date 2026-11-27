import type { Alert } from '@eko/shared';
import type { LedPattern } from './led';

/**
 * What a new alert's pop-up says: a first-party label for its kind and the coin, then the alert's own sentence, short.
 * Text from the alert passes through `plain` (no control or direction-changing characters, one line, clipped), since a
 * coin's name or symbol is written by whoever launched it.
 */
const KIND: Record<Alert['kind'], string> = {
  verdict_change: 'Verdict changed', playbook: 'Warning sign found', crew_active: 'Crew active', agent_flow_spike: 'Agent buying spike',
  approval: 'Approval needed', order: 'Order update', agent_trade: 'Your agent traded', wallet_trade: 'Tracked wallet traded',
  dev_sell: 'Dev sold', launch_match: 'New coin matches your filter', price: 'Price alert', curve: 'Bonding curve update',
  dump_risk: 'Dump risk rose',
};
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
export function plain(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').replace(HIDDEN, '').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}
export function alertSummary(alert: Alert): { title: string; body: string } {
  const symbol = alert.symbol?.text ? plain(alert.symbol.text, 16) : '';
  const title = `${KIND[alert.kind] ?? 'New alert'}${symbol ? ` · $${symbol.replace(/^\$/, '')}` : ''}`;
  return { title, body: plain(alert.body || alert.title, 140) };
}

/**
 * The LED a new alert's pop-up shows in place of the plain icon, by what happened: money leaving (a dev sold, dump risk
 * rose) falls in coral; a new match sparkles; a verdict change scans in the Monitor colour; price and curve moves
 * breathe in blue. Other kinds keep the plain icon.
 */
export function alertLed(kind: Alert['kind']): { pattern: LedPattern; tone: 'blue' | 'ice' | 'coral' } | undefined {
  switch (kind) {
    case 'dev_sell': case 'dump_risk': return { pattern: 'fall', tone: 'coral' };
    case 'launch_match': return { pattern: 'sparkle', tone: 'blue' };
    case 'verdict_change': return { pattern: 'scan', tone: 'ice' };
    case 'price': case 'curve': return { pattern: 'pulse', tone: 'blue' };
    default: return undefined;
  }
}
