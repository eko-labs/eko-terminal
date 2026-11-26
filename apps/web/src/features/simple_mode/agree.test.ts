import { describe, expect, it } from 'vitest';
import { PLAYBOOK_PLAIN, REASON_PLAIN, agreeWithReasons, type Fact } from './model';

const top: Fact = { id: 'top', label: 'Top 10 own', value: '21%', line: 'Spread across many people', tone: 'good', gauge: 21 };
const sell: Fact = { id: 'sell', label: 'Can you sell it?', value: 'Yes', line: 'EKO tested a sale', tone: 'good' };

describe('tiles agree with the reasons', () => {
  it('never calls holders spread out when a reason says a few hold a lot', () => {
    for (const text of [REASON_PLAIN.TOP_HOLDERS, PLAYBOOK_PLAIN.holder_concentration, PLAYBOOK_PLAIN.bundle_dump]) {
      const [t, s] = agreeWithReasons([top, sell], [{ tone: 'watch', text }]);
      expect(t).toMatchObject({ value: '21%', tone: 'watch', line: 'EKO flags a few big holders' });
      expect(s).toBe(sell);
    }
  });
  it('leaves the tiles alone when no reason is about holders', () => {
    expect(agreeWithReasons([top, sell], [{ tone: 'bad', text: PLAYBOOK_PLAIN.run_up }])).toEqual([top, sell]);
  });
});
