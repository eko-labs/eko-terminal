import type { ReactNode } from "react";
import mark from "../assets/eko-mark.svg";
import { CHAIN_NAME, NON_AFFILIATION } from "../chain";
import type { Section } from "./content";
import "./docs.css";

export function DocumentHeader({ page, skipTo, children }: { page: "Docs" | "Whitepaper"; skipTo: string; children?: ReactNode }) {
  return <>
    <a className="docs-skip" href={skipTo}>Skip to main content</a>
    <header className="docs-topbar">
      <a className="eko-brand docs-brand" href="/" aria-label="EKO home">
        <img src={mark} alt="" />
        <span className="eko-brand-text">EKO</span>
        <span className="docs-brand-caption">{page}</span>
      </a>
      {children}
      <nav aria-label="EKO navigation">
        {page === "Docs" ? <a href="/site/whitepaper.html">Whitepaper</a> : <a href="/site/docs.html">Docs</a>}
        <a href="/radar">Terminal ↗</a>
      </nav>
    </header>
  </>;
}

export function DocumentSection({ section, heading: Heading }: { section: Section; heading: "h2" | "h3" }) {
  return <section id={section.id} className="docs-block">
    <Heading>{section.title}</Heading>
    {section.paragraphs.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
    {section.links && <ul className="docs-links">
      {section.links.map(link => <li key={link.href}><a href={link.href}>{link.label} <span aria-hidden="true">↗</span></a></li>)}
    </ul>}
  </section>;
}

export function DocumentFooter() {
  return <footer className="docs-footer">
    <p>Built on {CHAIN_NAME}. {NON_AFFILIATION}</p>
    <p>DYOR · Not financial advice</p>
  </footer>;
}
