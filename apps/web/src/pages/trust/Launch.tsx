import type { ReactNode } from 'react';
import { BUILT_ON, DYOR, NON_AFFILIATION } from '../../copy';
import { NOT_PUBLISHED, OFFICIAL_COPY as O, PENDING_OWNER, PROJECT_LINKS, SECURITY_COPY as S, TRANSPARENCY_COPY as T, TRUST_COPY as C } from '../../copy/trust';
import { Link } from '../../lib/Link';
import '../legal.css';

// TODO(spec): Project wallet, contract and social identifiers are not supplied yet. They stay "Not published
// yet" until the owner publishes them with provenance; never fill them with sample values.
const PAGES = [['/official', C.official], ['/transparency', C.transparency], ['/security', C.security], ['/scoreboard', C.scoreboard], ['/legal/terms', C.policies]] as const;

/** External or server-served link: a plain anchor, never SPA navigation. */
function Out({ href, children }: { href: string; children: ReactNode }) {
  return href.startsWith('https:') ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <a href={href}>{children}</a>;
}
function Frame({ title, path, children }: { title: string; path: string; children: ReactNode }) {
  return <div className="shell-page legal-page trust-launch">
    <header className="page-head"><span className="eyebrow">{C.eyebrow}</span><h1>{title}</h1></header>
    <nav className="policy-links" aria-label={C.nav}>{PAGES.map(([to, label]) => <Link key={to} to={to} aria-current={to === path ? 'page' : undefined}>{label}</Link>)}</nav>
    <aside className="legal-review trust-warning" aria-label={C.warningTitle}><h2>{C.warningTitle}</h2>{C.warning.map(text => <p key={text}>{text}</p>)}</aside>
    <article>{children}</article>
    <footer className="legal-footer"><p>{BUILT_ON}</p><p>{NON_AFFILIATION}</p><p>{DYOR}</p></footer>
  </div>;
}
function Facts({ rows }: { rows: readonly { label: string; note: string; value: ReactNode }[] }) {
  return <dl className="trust-facts">{rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}{row.note && <span className="trust-note">{row.note}</span>}</dd></div>)}</dl>;
}
const unpublished = <strong className="trust-status">{NOT_PUBLISHED}</strong>;

export function Official() {
  return <Frame title={C.official} path="/official">
    <p>{O.intro}</p>
    <section><h2>{O.verifiedTitle}</h2><Facts rows={O.verified.map(link => ({ ...link, value: <Out href={link.href}>{link.text}</Out> }))} /></section>
    <section><h2>{O.unpublishedTitle}</h2><p>{O.unpublishedIntro}</p><Facts rows={O.unpublished.map(item => ({ ...item, value: unpublished }))} /></section>
  </Frame>;
}

export function Transparency() {
  return <Frame title={C.transparency} path="/transparency">
    <section><h2>{T.walletsTitle}</h2><p>{T.walletsIntro}</p><Facts rows={T.wallets.map(item => ({ ...item, value: unpublished }))} /></section>
    <section><h2>{T.feesTitle}</h2>{T.fees.map(text => <p key={text}>{text}</p>)}</section>
    <section><h2>{T.reviewTitle}</h2>{T.review.map(text => <p key={text}>{text}</p>)}<p><Out href={PROJECT_LINKS.findings}>{T.findingsLink}</Out> · <Link to="/security">{C.security}</Link></p></section>
    <section><h2>{T.tokenTitle}</h2>{T.token.map(text => <p key={text}>{text}</p>)}</section>
    <section><h2>{T.checkTitle}</h2>{T.check.map(text => <p key={text}>{text}</p>)}</section>
  </Frame>;
}

export function Security() {
  return <Frame title={C.security} path="/security">
    <section className="legal-review" aria-label={S.statusTitle}><h2>{S.statusTitle}</h2>{S.status.map(text => <p key={text}>{text}</p>)}</section>
    <section><h2>{S.reportTitle}</h2><Facts rows={S.channels.map(channel => ({ label: channel.label, note: '', value: <Out href={channel.href}>{channel.text}</Out> }))} /><ul>{S.report.map(text => <li key={text}>{text}</li>)}</ul></section>
    <section><h2>{S.scopeTitle}</h2><ul>{S.scope.map(text => <li key={text}>{text}</li>)}</ul></section>
    <section><h2>{S.outTitle}</h2><ul>{S.out.map(text => <li key={text}>{text}</li>)}</ul></section>
    <section><h2>{S.rulesTitle}</h2><ul>{S.rules.map(text => <li key={text}>{text}</li>)}</ul></section>
    <section><h2>{S.goodFaithTitle} · {PENDING_OWNER}</h2>{S.goodFaith.map(text => <p key={text}>{text}</p>)}</section>
    <p><Out href={PROJECT_LINKS.securityPolicy}>{S.fullPolicy}</Out> · <Out href={PROJECT_LINKS.securityTxt}>security.txt</Out></p>
  </Frame>;
}
