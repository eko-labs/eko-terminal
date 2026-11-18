import { useEffect, useRef, useState } from "react";
import { CHAIN_NAME } from "../chain";
import { guides } from "./content";
import { DocumentFooter, DocumentHeader, DocumentSection } from "./DocumentFrame";

const initialGuide = () => guides.find(guide => guide.id === location.hash.slice(1)) ?? guides[0];

export default function DocsPage() {
  const [guide, setGuide] = useState(initialGuide);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const current = guides.indexOf(guide);
  const term = query.trim().toLowerCase();
  const results = guides.filter(candidate => [
    candidate.label, candidate.intro, ...candidate.sections.flatMap(section => [section.title, ...section.paragraphs]),
  ].join(" ").toLowerCase().includes(term));

  function choose(id: string) {
    if (location.hash !== `#${id}`) history.pushState(null, "", `#${id}`);
    setGuide(initialGuide());
    setQuery("");
    requestAnimationFrame(() => {
      const target = document.getElementById("guide");
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "start" });
    });
  }

  useEffect(() => {
    const onHash = () => setGuide(initialGuide());
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        search.current?.focus();
      }
      if (event.key === "Escape") setQuery("");
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    const frame = guides.some(candidate => `#${candidate.id}` === location.hash)
      ? requestAnimationFrame(() => document.getElementById("guide")?.scrollIntoView())
      : 0;
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => { document.title = `EKO Docs — ${guide.label}`; }, [guide]);

  return <div className="docs-page">
    <DocumentHeader page="Docs" skipTo="#guide">
      <div className="docs-search-wrap" onFocus={() => setSearchFocused(true)}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSearchFocused(false); }}>
        <label className="docs-search">
          <input ref={search} type="search" aria-label="Search documentation" placeholder="Search documentation"
            value={query} onChange={event => setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && term && results[0]) choose(results[0].id); }} />
          <kbd>⌘ / Ctrl K</kbd>
        </label>
        {searchFocused && term && <div className="docs-search-results" aria-label="Search results">
          {results.length ? results.map(result =>
            <button key={result.id} onClick={() => choose(result.id)}>{result.label}</button>,
          ) : <p>No matching guide.</p>}
        </div>}
      </div>
    </DocumentHeader>

    <section className="docs-hero">
      <span className="docs-eyebrow"><i />{CHAIN_NAME}</span>
      <h1>EKO Docs</h1>
      <p>Find tracked coins, read EKO’s checks and trade from your own wallet.</p>
    </section>

    <div className="docs-workspace">
      <nav className="docs-sidebar" aria-label="Documentation contents">
        <p className="docs-sidebar-top">In this guide</p>
        {guides.map(item =>
          <button key={item.id} aria-current={guide.id === item.id ? "page" : undefined} onClick={() => choose(item.id)}>
            {item.label}
          </button>,
        )}
      </nav>
      <main id="guide" className="docs-article" tabIndex={-1}>
        <h2 className="docs-article-title">{guide.label}</h2>
        <p className="docs-lead">{guide.intro}</p>
        {guide.sections.map(section => <DocumentSection key={section.id} section={section} heading="h3" />)}
        <nav className="docs-pagination" aria-label="Previous and next guide">
          {current > 0 && <button onClick={() => choose(guides[current - 1].id)}>← {guides[current - 1].label}</button>}
          {current < guides.length - 1 && <button onClick={() => choose(guides[current + 1].id)}>{guides[current + 1].label} →</button>}
        </nav>
      </main>
    </div>
    <DocumentFooter />
  </div>;
}
