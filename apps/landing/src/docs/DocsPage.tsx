import { useEffect, useRef, useState, type CSSProperties } from "react";
import { motion, useReducedMotion } from "framer-motion";
import mark from "../assets/eko-mark.svg";
import { guides } from "./content";
import "./docs.css";

const nodes = [
  { id: "senses", name: "Senses", caption: "Read the context", x: 20, y: 20, number: "01" },
  { id: "guardrails", name: "Guardrails", caption: "Check the intent", x: 80, y: 20, number: "02" },
  { id: "loop-lab", name: "Loop Lab", caption: "Test the rules", x: 89, y: 61, number: "03" },
  { id: "recorder", name: "Recorder", caption: "Keep the trace", x: 50, y: 88, number: "04" },
  { id: "mission", name: "Mission Control", caption: "Stay in the loop", x: 11, y: 61, number: "05" },
];
const initialGuide = () => guides.find(g => g.id === location.hash.slice(1))?.id || "overview";

function PolicySandbox() {
  const [amount, setAmount] = useState(1400);
  const [limit, setLimit] = useState(1000);
  const [blocked, setBlocked] = useState(false);
  const [approvals, setApprovals] = useState(true);
  const [copy, setCopy] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const decision = blocked || (amount > limit && !approvals) ? "deny" : amount > limit ? "needs_approval" : "allow";
  const reason = blocked ? "Asset is on the example blocklist." : amount > limit ? approvals ? `$${amount.toLocaleString()} exceeds the $${limit.toLocaleString()} approval threshold.` : "approval_unavailable: this example cannot request approval." : "Amount is within the example policy.";
  const payload = JSON.stringify({ decision, reasons: [reason], policyVersion: 1, illustrative: true }, null, 2);
  async function copyResponse() {
    try { await navigator.clipboard.writeText(payload); setCopy("Copied"); }
    catch { setCopy("Select the response to copy"); }
    clearTimeout(timer.current); timer.current = setTimeout(() => setCopy(""), 2500);
  }
  return <aside className="docs-sandbox" aria-labelledby="sandbox-heading">
    <div className="docs-panel-meta"><span><i />INTERACTIVE EXAMPLE</span><span>01 / POLICY</span></div>
    <h2 id="sandbox-heading">Try a preflight.</h2><p>Change the intent.<br />Watch the decision respond.</p>
    <label className="docs-amount" htmlFor="sample-amount">Proposed amount <output>${amount.toLocaleString()}</output></label>
    <input id="sample-amount" type="range" min="100" max="2500" step="100" value={amount} onChange={e => setAmount(Number(e.target.value))} />
    <div className="docs-range-label"><span>$100</span><span>$2,500</span></div>
    <label className="docs-limit">Approval threshold<select value={limit} onChange={e => setLimit(Number(e.target.value))}><option value="500">$500</option><option value="1000">$1,000</option><option value="2000">$2,000</option></select></label>
    <label className="docs-check"><input type="checkbox" checked={blocked} onChange={e => setBlocked(e.target.checked)} />Asset is blocked</label>
    <label className="docs-check"><input type="checkbox" checked={approvals} onChange={e => setApprovals(e.target.checked)} />Approvals available</label>
    <div className={`docs-decision docs-decision-${decision}`} aria-live="polite"><span>POLICY RESPONSE</span><strong>{decision === "needs_approval" ? "Review required" : decision === "deny" ? "Action denied" : "Within policy"}</strong><p>{reason}</p></div>
    <div className="docs-code-head"><span>ILLUSTRATIVE RESPONSE</span><button onClick={copyResponse}>{copy || "Copy ↗"}</button></div><pre tabIndex={0}><code>{payload}</code></pre>
    <p className="docs-sandbox-note">Local illustration of two policy rules. It sends no orders or API requests.</p>
  </aside>;
}

export default function DocsPage() {
  const [selected, setSelected] = useState(initialGuide);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const reduced = useReducedMotion();
  const search = useRef<HTMLInputElement>(null);
  const article = useRef<HTMLElement>(null);
  const guide = guides.find(g => g.id === selected) || guides[0];
  const current = guides.indexOf(guide);
  const result = guides.filter(g => `${g.title} ${g.label} ${g.intro} ${g.tools.join(" ")} ${g.blocks.map(b => b.body).join(" ")}`.toLowerCase().includes(query.toLowerCase().trim()));
  const activeNode = nodes.find(n => n.id === (hovered || selected));

  function choose(id: string, scroll = true) {
    setSelected(id); setQuery(""); setSearchFocused(false); setMenuOpen(false);
    if (location.hash !== `#${id}`) history.pushState(null, "", `#${id}`);
    if (scroll) requestAnimationFrame(() => article.current?.scrollIntoView({ behavior: reduced ? "instant" : "smooth", block: "start" }));
  }
  useEffect(() => {
    const onHash = () => setSelected(initialGuide());
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); search.current?.focus(); }
      if (e.key === "Escape") { setSearchFocused(false); setMenuOpen(false); search.current?.blur(); }
    };
    window.addEventListener("hashchange", onHash); window.addEventListener("keydown", onKey);
    const frame = location.hash ? requestAnimationFrame(() => article.current?.scrollIntoView({ behavior: "instant" })) : 0;
    return () => { window.removeEventListener("hashchange", onHash); window.removeEventListener("keydown", onKey); cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => { document.title = `EKO Docs — ${guide.label}`; }, [guide]);

  return <div className="docs-page" data-still={Boolean(reduced) || paused}>
    <a className="docs-skip" href="#guide">Skip to documentation</a>
    <header className="docs-topbar">
      <a className="eko-brand docs-brand" href="/" aria-label="EKO home"><img src={mark} alt="" /><span className="eko-brand-text">EKO</span><span className="docs-brand-caption">FIELD MANUAL</span></a>
      <div className="docs-search-wrap" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setSearchFocused(false); }}>
        <label className="docs-search"><span aria-hidden="true">⌕</span><input ref={search} aria-label="Search documentation" placeholder="Find your way through EKO" value={query} onFocus={() => setSearchFocused(true)} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && result[0]) choose(result[0].id); }} /><kbd>⌘ / Ctrl K</kbd></label>
        {searchFocused && query.trim() && <div className="docs-search-results" aria-label="Search results">{result.length ? result.map(g => <button key={g.id} onClick={() => choose(g.id)}><span>{g.label}</span><strong>{g.title}</strong><span>↗</span></button>) : <p>No matching guide. Try “policy”, “journal” or “agent”.</p>}</div>}
      </div>
      <nav aria-label="Docs navigation"><a href="/">Website ↗</a><a href="/radar">Terminal ↗</a><button onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-controls="docs-navigation">{menuOpen ? "Close −" : "Contents +"}</button></nav>
    </header>

    <section className="docs-hero" aria-labelledby="docs-title">
      <div className="docs-hero-copy"><span className="docs-eyebrow"><i />EKO / DOCUMENTATION</span><h1 id="docs-title">Intelligence,<br /><span>with a manual.</span></h1><p>Get inside the signal.<br />Understand the system.<br />Make the next move yours.</p><button className="docs-enter" onClick={() => choose("overview")}>Explore the field guide <span>↓</span></button><span className="docs-edition">08 GUIDES / ONE CONNECTED SYSTEM</span></div>
      <div className="docs-map" aria-label="Interactive EKO system map">
        <div className="docs-map-grid" aria-hidden="true" />
        <span className="docs-map-caption">SYSTEM ATLAS / SELECT A COMPONENT</span>
        <svg className="docs-map-connections" viewBox="0 0 600 500" preserveAspectRatio="none" aria-hidden="true">
          <path d="M120 100 300 230 480 100M300 230 534 305M300 230 300 440M300 230 66 305" stroke="#284252" fill="none" />
          <path className="docs-signal-path" d="M120 100 300 230 480 100M300 230 534 305M300 230 300 440M300 230 66 305" stroke="#aad8f4" strokeDasharray="2 24" fill="none" />
          <circle cx="300" cy="230" r="85" stroke="#385666" fill="none" strokeDasharray="1 8"/><circle className="docs-orbit" cx="300" cy="230" r="108" stroke="#6594ae" strokeDasharray="120 559" fill="none" />
          <path d="M10 15h15M10 15v15M590 15h-15M590 15v15M10 485h15M10 485v-15M590 485h-15M590 485v-15" stroke="#4a6a7d" />
        </svg>
        <div className="docs-core" aria-hidden="true"><img src={mark} alt=""/><span>EKO HARNESS</span></div>
        {nodes.map(n => <button key={n.id} className="docs-map-node" data-active={activeNode?.id === n.id} style={{ "--x": `${n.x}%`, "--y": `${n.y}%` } as CSSProperties} onMouseEnter={() => setHovered(n.id)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(n.id)} onBlur={() => setHovered(null)} onClick={() => choose(n.id)}><span>{n.number} / {n.caption}</span><strong>{n.name}</strong><i aria-hidden="true">↗</i></button>)}
        <button className="docs-motion" onClick={() => setPaused(!paused)} disabled={Boolean(reduced)}>{reduced ? "Still view" : paused ? "Play motion ▷" : "Pause motion Ⅱ"}</button>
      </div>
    </section>

    <nav className="docs-path" aria-label="Getting started path">{[["overview","Orient yourself","Understand the system"],["connect","Connect an agent","Keep ownership"],["guardrails","Set the boundaries","Explore a preflight"],["recorder","Follow the trace","Keep the evidence"]].map(([id,title,caption],i)=><button key={id} onClick={()=>choose(id)}><span>0{i+1}</span><div><strong>{title}</strong><small>{caption}</small></div><b>↗</b></button>)}</nav>

    <div className="docs-workspace">
      <aside id="docs-navigation" className="docs-sidebar" data-open={menuOpen} aria-label="Documentation contents"><div className="docs-sidebar-top"><span>THE FIELD GUIDE</span><span>{String(current+1).padStart(2,"0")} / 08</span></div>{["Start here","The components","What’s next"].map(group=><div className="docs-nav-group" key={group}><h2>{group}</h2>{guides.filter(g=>g.group===group).map(g=><button key={g.id} aria-current={selected===g.id ? "page":undefined} onClick={()=>choose(g.id)}><span>{String(guides.indexOf(g)+1).padStart(2,"0")}</span>{g.label}<b>↗</b></button>)}</div>)}<a className="docs-roadmap-link" href="/#roadmap">Explore EKO <span>↗</span></a><p>Product concepts & planned capabilities.<br />Illustrative examples.</p></aside>

      <main id="guide" ref={article} className="docs-article" tabIndex={-1}>
        <motion.div key={guide.id} initial={{ opacity: 0, y: reduced ? 0 : 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .35 }}>
          <div className="docs-article-meta"><span>{guide.group} / {guide.label}</span><span>{guide.read} READ</span></div>
          <h2>{guide.title}</h2><p className="docs-lead">{guide.intro}</p>
          <div className="docs-tool-strip" aria-label="Related capabilities">{guide.tools.map(t=><span key={t}>{t}</span>)}</div>
          {guide.blocks.map((block,index)=><section className="docs-block" key={block.title}><div className="docs-block-index">{String(index+1).padStart(2,"0")}<span/></div><div><h3>{block.title}</h3><p>{block.body}</p>{block.items&&<ul>{block.items.map(item=><li key={item}><span>↳</span>{item}</li>)}</ul>}</div></section>)}
          <div className="docs-takeaway"><img src={mark} alt=""/><div><span>KEEP THIS IN MIND</span><p>{guide.takeaway}</p></div></div>
          <div className="docs-pagination"><button disabled={current===0} onClick={()=>choose(guides[current-1].id)}><span>← PREVIOUS</span>{current>0?guides[current-1].label:"You’re at the beginning"}</button><button disabled={current===guides.length-1} onClick={()=>choose(guides[current+1].id)}><span>NEXT →</span>{current<guides.length-1?guides[current+1].label:"You’re up to date"}</button></div>
        </motion.div>
      </main>
      <PolicySandbox />
    </div>
    <footer className="docs-footer"><a className="eko-brand docs-brand" href="/"><img src={mark} alt=""/><span className="eko-brand-text">EKO</span></a><p>Independent minds.<br />Connected intelligence.</p><a href="/">Back to the website ↗</a><span>© 2026 EKO / FIELD MANUAL</span></footer>
  </div>;
}
