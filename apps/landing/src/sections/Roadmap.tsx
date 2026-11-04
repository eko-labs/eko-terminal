import { useRef, useState } from "react";
import { motion, useInView, useReducedMotion, useScroll, useTransform } from "framer-motion";
import { roadmapDrops } from "./roadmap-data";
import ekoMark from "../assets/eko-mark.svg";
import "./bento-system.css";
import "./roadmap.css";

const phases = [
  { title: "Read the network", range: "DROPS 01—03", target: 1, text: "Intelligence, patterns & a proving ground." },
  { title: "Build the workflow", range: "DROPS 04—06", target: 4, text: "Research, ownership & strategy testing." },
  { title: "Extend the system", range: "DROPS 07—09", target: 7, text: "Reputation, networks & a connected ecosystem." },
];

export default function Roadmap() {
  const road = useRef<HTMLDivElement>(null);
  const visible = useInView(road, { margin: "200px 0px" });
  const reduced = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const { scrollYProgress } = useScroll({ target: road, offset: ["start center", "end center"] });
  const travellerTop = useTransform(scrollYProgress, [0, 1], ["1.5%", "98.5%"]);
  const still = paused || Boolean(reduced) || !visible;
  const toggle = (index: number) => setExpanded(previous => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next; });

  return <section id="roadmap" className="bento-section road-section" aria-labelledby="roadmap-heading">
    <header className="bento-heading road-heading"><span className="bento-badge"><i />05 / The road ahead</span><h2 id="roadmap-heading">Follow the signal forward.<span className="bento-muted">One drop at a time.</span></h2><div><p>A clear path from market intelligence to a connected agent ecosystem. Explore the scope behind each planned release.</p><button onClick={() => setPaused(!paused)} disabled={Boolean(reduced)} aria-label={paused ? "Play roadmap animation" : "Pause roadmap animation"}>{reduced ? "Still frame" : paused ? "Play motion ▷" : "Pause motion Ⅱ"}</button></div></header>

    <nav className="road-phases" aria-label="Roadmap chapters">{phases.map((phase,index)=><a href={`#drop-${phase.target}`} key={phase.title}><span className="road-phase-number">0{index+1}</span><div><span>{phase.range}</span><strong>{phase.title}</strong><p>{phase.text}</p></div><b>↓</b></a>)}</nav>
    <div className="road-axis-label" aria-hidden="true"><span>PLANNED SEQUENCE</span><i /></div>
    <div ref={road} className="road-stops">
      <div className="road-rail" aria-hidden="true"><div className="road-rail-ticks"/><motion.div className="road-rail-progress" style={{ scaleY: scrollYProgress }}/></div>
      <motion.div className="road-traveller" aria-hidden="true" style={{ top: travellerTop }}><img src={`${import.meta.env.BASE_URL}media/eko-road-core${still ? "-still" : ""}.webp`} width="240" height="240" alt=""/><img className="road-traveller-mark" src={ekoMark} alt=""/></motion.div>
      <ol className="road-items">{roadmapDrops.map((drop,index)=>{
        const isOpen = expanded.has(index);
        return <li className={`road-stop ${index%2 ? "road-right":"road-left"}`} id={`drop-${index+1}`} key={drop.title}>
          <span className="road-node" aria-hidden="true">{String(index+1).padStart(2,"0")}</span><span className="road-connector" aria-hidden="true"/>
          <motion.article className="road-card" data-open={isOpen} initial={{opacity:0,y:reduced?0:24}} whileInView={{opacity:1,y:0}} viewport={{once:true,amount:.15}} transition={{duration:.6,ease:"easeOut"}}>
            <div className="road-card-texture" aria-hidden="true"/>
            <header className="road-card-meta"><span>DROP {String(index+1).padStart(2,"0")} <i/> {drop.category.split(" / ")[0]}</span><span>PLANNED</span></header>
            <h3>{drop.title}</h3><p className="road-summary">{drop.summary}</p>
            <button id={`drop-toggle-${index}`} className="road-toggle" aria-label={`${isOpen ? "Close" : "Explore"} Drop ${index+1}: ${drop.title} release scope`} aria-expanded={isOpen} aria-controls={`drop-detail-${index}`} onClick={()=>toggle(index)}><span>{isOpen ? "Close release scope" : "Explore release scope"}</span><b aria-hidden="true">{isOpen?"−":"+"}</b></button>
            <div id={`drop-detail-${index}`} className="road-details" hidden={!isOpen} role="region" aria-label={`Drop ${index+1}: ${drop.title} release scope`}>
              <p className="road-intent">{drop.intent}</p><ol>{drop.scope.map(([title,description],i)=><li key={title}><span>{String(i+1).padStart(2,"0")}</span><div><h4>{title}</h4><p>{description}</p></div></li>)}</ol><div className="road-gate"><span>RELEASE REQUIREMENT</span><p>{drop.gate}</p></div>
            </div>
          </motion.article>
          <div className="road-margin-note" aria-hidden="true"><span>{phases[Math.floor(index/3)].range}</span><p>{phases[Math.floor(index/3)].title}</p><i/></div>
        </li>;
      })}</ol>
    </div>
    <div className="road-finish"><img src={ekoMark} alt=""/><span>EVERY RELEASE FOLLOWS THE SAME STANDARD</span><p>Demonstrate it. Test it. Document it.</p><div><span>01 / Recorded demo</span><span>02 / Evaluation gates</span><span>03 / Release notes & limits</span></div></div>
    <div className="bento-comb" aria-hidden="true"/><p className="road-footnote">Planned sequence. Scope and timing may change as release checks are completed.</p>
  </section>;
}
