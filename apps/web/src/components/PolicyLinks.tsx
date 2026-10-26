import { BUYER_RISK } from '../copy/guard';
import { DYOR, NON_AFFILIATION, BUILT_ON } from '../copy';
import { LEGAL_COPY, POLICY_DRAFTS } from '../copy/legal';
import { Link } from '../lib/Link';
import { createContext, useContext, type ReactNode } from 'react';

const PageAnalysisNotice = createContext(false);
/** A page with its own notice suppresses repeated notices in nested cards. */
export function AnalysisPolicyScope({ children }: { children: ReactNode }) {
  return <PageAnalysisNotice.Provider value={true}>{children}</PageAnalysisNotice.Provider>;
}

export function PolicyLinks({ current }: { current?: string }) {
  return <nav className="policy-links" aria-label={LEGAL_COPY.navigation}>{POLICY_DRAFTS.map((policy) =>
    <Link key={policy.slug} to={`/legal/${policy.slug}`} aria-current={current === policy.slug ? 'page' : undefined}>{policy.title}</Link>,
  )}</nav>;
}

export function AnalysisPolicyNotice({ page = false }: { page?: boolean }) {
  const hasPageNotice = useContext(PageAnalysisNotice);
  if (hasPageNotice && !page) return null;
  return <div className="foot-meta analysis-policy-notice"><p>{BUYER_RISK}</p><p>{DYOR}</p><p>{BUILT_ON} · {NON_AFFILIATION}</p><p><Link to="/legal/risk">{POLICY_DRAFTS[2].title}</Link> · <Link to="/legal/ai">{POLICY_DRAFTS[3].title}</Link> · <Link to="/legal/terms">{POLICY_DRAFTS[0].title}</Link></p></div>;
}
