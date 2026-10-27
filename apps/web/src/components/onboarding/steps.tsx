import type { ReactNode } from 'react';
import type { ChecklistStep, TourAnchor } from '../../store/onboarding';
import { useUi, type MobileSheet } from '../../store/ui';

export function openMobile(sheet: MobileSheet) {
  useUi.getState().set({ mobileSheet: sheet });
}
export interface TourStep {
  anchor: TourAnchor;
  title: string;
  body: ReactNode;
  mobileSheet: MobileSheet;
  placement?: 'right' | 'left' | 'top' | 'bottom';
}
const step = (anchor: TourAnchor, title: string, body: string): TourStep => ({ anchor, title, body, mobileSheet: 'none' });
export const TOUR_STEPS: TourStep[] = [
  step('scan', 'Scan a coin', 'Paste a contract address or ticker to request a scan.'),
  step('verdict', 'Read the verdict', 'Review the observations, missing checks and freshness. A verdict is not a recommendation.'),
  step('playbooks', 'Open the evidence', 'Named playbook matches link to the observations behind them.'),
  step('flow-markers', 'Read the flow markers', 'Markers describe indexed trading activity. Wallet labels are estimates, not a reason to buy.'),
  step('coin-card', 'Review the coin card', 'Inspect liquidity, supply, control and measured exit costs when available.'),
  step('fee-lines', 'Review costs', 'Review terminal fees, taxes, network fees and exit costs for this quote.'),
  step('trade', 'Trade with the guard', 'Review the guard checks and warnings. Your wallet signs any trade; EKO never holds funds.'),
  step('mode', 'Choose a risk mode', 'The risk mode changes guard thresholds. Refusals remain visible.'),
  step('mission', 'Connect an agent', 'Open Mission Control to connect your own agent and review its limits and journal.'),
  step('wallet', 'Your wallet', 'Connect and sign in when you want to scan your bags or consider a trade.'),
];
export const POINTERS: Record<ChecklistStep, { anchor: TourAnchor; title: string; body: ReactNode; mobileSheet: MobileSheet }> = {
  scan_coin: step('scan', 'Scan a coin', 'Paste a contract address or ticker.' ),
  open_evidence: step('verdict', 'Open the evidence', 'Open verdict evidence or a playbook’s evidence disclosure.'),
  scan_bags: step('wallet', 'Scan my bags', 'Sign in with your wallet to review indexed holdings.'),
  guarded_trade: step('trade', 'First guarded trade', 'Review checks and costs. Completion requires a confirmed trade, not a quote or signature.'),
  connect_agent: step('mission', 'Connect an agent', 'Follow the pack instructions and test the connection. Completion requires a received harness call.'),
};
export const CHECKLIST_COPY: Record<ChecklistStep, { label: string; hint: string }> = {
  scan_coin: { label: 'Scan a coin', hint: 'Render a completed scan result' },
  open_evidence: { label: 'Open the evidence', hint: 'Review the observations behind a verdict' },
  scan_bags: { label: 'Scan my bags', hint: 'Read your indexed holdings' },
  guarded_trade: { label: 'A first guarded trade', hint: 'Your wallet signs; wait for confirmation' },
  connect_agent: { label: 'Connect an agent', hint: 'Test a received harness call' },
};

/** Only implemented, visible controls can be stops; hidden sheets and gates are skipped. */
export function findAnchor(anchor: TourAnchor): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`)].find(el => {
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width >= 2 && r.height >= 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }) ?? null;
}
export function availableTourSteps() { return TOUR_STEPS.filter(s => findAnchor(s.anchor)); }
