import { CHAIN_NAME } from "../chain";
import { DocumentFooter, DocumentHeader, DocumentSection } from "./DocumentFrame";
import { whitepaper, whitepaperIntro } from "./whitepaper";

export default function WhitepaperPage() {
  return <div className="docs-page">
    <DocumentHeader page="Whitepaper" skipTo="#whitepaper" />
    <div className="docs-hero">
      <span className="docs-eyebrow"><i />{CHAIN_NAME}</span>
      <h1>EKO Whitepaper</h1>
      <p>{whitepaperIntro}</p>
    </div>
    <div className="docs-workspace">
      <nav className="docs-sidebar" aria-label="Whitepaper contents">
        <p className="docs-sidebar-top">Contents</p>
        {whitepaper.map(section => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}
      </nav>
      <main id="whitepaper" className="docs-article" tabIndex={-1}>
        {whitepaper.map(section => <DocumentSection key={section.id} section={section} heading="h2" />)}
      </main>
    </div>
    <DocumentFooter />
  </div>;
}
