import type { Alert } from '@eko/shared';

/**
 * What a new alert's pop-up says: a first-party label for its kind and the coin, then the alert's own sentence, short.
 * Text from the alert passes through `plain` (no control or direction-changing characters, one line, clipped), since a
 * coin's name or symbol is written by whoever launched it.
 */
const KIND: Record<Alert['kind'], string> = {
  verdict_change: 'Verdict changed', playbook: 'Warning sign found', crew_active: 'Crew active', agent_flow_spike: 'Agent buying spike',
  approval: 'Approval needed', order: 'Order update', agent_trade: 'Your agent traded', wallet_trade: 'Tracked wallet traded',
  dev_sell: 'Dev sold', launch_match: 'New coin matches your filter', price: 'Price alert', curve: 'Bonding curve update',
};
const HIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
export function plain(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').replace(HIDDEN, '').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}
export function alertSummary(alert: Alert): { title: string; body: string } {
  const symbol = alert.symbol?.text ? plain(alert.symbol.text, 16) : '';
  const title = `${KIND[alert.kind] ?? 'New alert'}${symbol ? ` · $${symbol.replace(/^\$/, '')}` : ''}`;
  return { title, body: plain(alert.body || alert.title, 140) };
}
