import { BUILT_ON, DYOR, NON_AFFILIATION } from '../copy';
import { findPolicy, isApprovedPolicy, LEGAL_COPY as C, POLICY_APPROVAL, POLICY_REVIEW } from '../copy/legal';
import { PolicyLinks } from '../components/PolicyLinks';
import { Link } from '../lib/Link';
import './legal.css';

function Approved() {
  return <aside className="legal-review" aria-label={C.approved}><h2>{C.approved}</h2><p>{C.approvedNote}</p><dl>
    <div><dt>{C.version}</dt><dd>{POLICY_APPROVAL.version}</dd></div>
    <div><dt>{C.approvalDate}</dt><dd><time dateTime={POLICY_APPROVAL.approvedAt}>{POLICY_APPROVAL.approvedAt}</time></dd></div>
  </dl></aside>;
}
function Draft() {
  return <aside className="legal-review" aria-label={C.draft}><h2>{C.draft}</h2><p>{C.review}</p><dl>
    <div><dt>{C.version}</dt><dd>{POLICY_REVIEW.version}</dd></div>
    <div><dt>{C.drafted}</dt><dd><time dateTime={POLICY_REVIEW.draftedAt}>{POLICY_REVIEW.draftedAt}</time></dd></div>
    <div><dt>{C.approvalDue}</dt><dd><time dateTime={POLICY_REVIEW.ownerApproval.dueAt}>{POLICY_REVIEW.ownerApproval.dueAt}</time></dd></div>
    <div><dt>{C.approvalDate}</dt><dd>{C.pending}</dd></div>
    <div><dt>{C.approvalEvidence}</dt><dd>{C.pending}</dd></div>
  </dl></aside>;
}

export default function Legal({ params }: { params: Record<string, string> }) {
  const policy = findPolicy(params.doc);
  return <div className="shell-page legal-page">
    <header className="page-head"><span className="eyebrow">{C.navigation}</span><h1>{policy?.title ?? C.missing}</h1></header>
    <PolicyLinks current={policy?.slug} />
    {policy ? <>
      {isApprovedPolicy(policy.slug) ? <Approved /> : <Draft />}
      <article>{policy.sections.map((section) => <section key={section.title}><h2>{section.title}</h2>{section.paragraphs.map((paragraph, i) => <p key={i}>{paragraph}</p>)}</section>)}</article>
      <p className="legal-contact">{C.website} · {C.questions} <Link to="/official">{C.official}</Link> · {C.security}</p>
    </> : <p role="status">{C.choose}</p>}
    <footer className="legal-footer"><p>{BUILT_ON}</p><p>{NON_AFFILIATION}</p><p>{DYOR}</p></footer>
  </div>;
}
