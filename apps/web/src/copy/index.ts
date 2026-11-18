import { DYOR, NON_AFFILIATION as ELYSIUM_NON_AFFILIATION, BUILT_ON as ELYSIUM_BUILT_ON } from '@eko/shared/disclosures';
import { pick } from '../lib/chain';

// The shared disclosures name Elysium's ecosystem; a Robinhood Chain build names Robinhood's instead.
export { DYOR };
export const NON_AFFILIATION = pick({ elysium: ELYSIUM_NON_AFFILIATION, robinhood: 'Not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.' });
export const BUILT_ON = pick({ elysium: ELYSIUM_BUILT_ON, robinhood: 'Built on Robinhood Chain' });
export const ADVISORY = 'Advisory: your agent is told to check with EKO before every order. It can ignore the check, and EKO cannot stop a wallet it does not control.';
export const ENFORCED_ONCHAIN = 'Enforced on-chain by this agent’s session-key policy.';
export const ONCHAIN_ADVISORY = 'Advisory for now: on-chain enforcement turns on after its contract review passes.';
export const APPROVAL_UNAVAILABLE = 'This order needs approval, which is not available for this agent.';
export const FEE_CURVE_ZERO = '0% on Pons-curve trades';
export const BETA = 'Beta · forecasts are graded against all launches';
export const REAL_FUNDS = 'Real funds · your wallet signs every trade';
