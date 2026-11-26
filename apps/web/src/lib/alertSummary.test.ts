import { describe, expect, it } from 'vitest';
import type { Alert } from '@eko/shared';
import { alertSummary, plain } from './alertSummary';
import { afterClear } from '../components/shell/AlertsDrawer';

const alert = (over: Partial<Alert>): Alert => ({ id: 'a', ts: '2026-11-26T12:00:00.000Z', kind: 'dev_sell', title: 'Dev sold', body: '', read: false, ...over } as Alert);

describe('alert pop-up summary', () => {
  it('says what happened and to which coin, then the alert sentence', () => {
    expect(alertSummary(alert({ symbol: { text: 'FROG', truncated: false, flags: [] }, body: 'The dev sold 12% of supply in 3 minutes.' })))
      .toEqual({ title: 'Dev sold · $FROG', body: 'The dev sold 12% of supply in 3 minutes.' });
    expect(alertSummary(alert({ kind: 'price', title: 'Crossed $0.004', body: '' }))).toEqual({ title: 'Price alert', body: 'Crossed $0.004' });
  });
  it('keeps launcher-written text plain: no hidden or direction-changing characters, one line, clipped', () => {
    expect(plain('a‮b​c\nd', 20)).toBe('abc d');
    expect(plain('x'.repeat(200), 20)).toHaveLength(20);
    expect(alertSummary(alert({ symbol: { text: '‮gnp.exe', truncated: false, flags: [] } })).title).toBe('Dev sold · $gnp.exe');
  });
});

describe('clearing the alerts drawer', () => {
  const older = alert({ id: 'o', ts: '2026-11-26T10:00:00.000Z' }), newer = alert({ id: 'n', ts: '2026-11-26T14:00:00.000Z' });
  it('hides alerts up to the clear and shows the ones after it', () => {
    expect(afterClear([newer, older], undefined)).toEqual([newer, older]);
    expect(afterClear([newer, older], '2026-11-26T12:00:00.000Z')).toEqual([newer]);
    expect(afterClear([newer, older], '2026-11-26T14:00:00.000Z')).toEqual([]);
  });
});
