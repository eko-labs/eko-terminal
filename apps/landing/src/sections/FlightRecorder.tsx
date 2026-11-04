import { useEffect, useRef, useState } from "react";
import { motion, useInView, useMotionValueEvent, useReducedMotion, useScroll, useTransform } from "framer-motion";
import "./flight-recorder.css";

const media = `${import.meta.env.BASE_URL}media/`;
const entries = [
  { name: "Context", code: "READING", title: "What the agent saw.", body: "The market reading, wallet activity and liquidity context available at the moment of a decision.", fields: ["Wallet activity", "Liquidity context", "Reading freshness"] },
  { name: "Preflight", code: "POLICY", title: "What the policy said.", body: "The requested action, the policy it was checked against, and the reasons behind the check.", fields: ["Position limits", "Asset policy", "Approval state"] },
  { name: "Decision", code: "INTENT", title: "Why the agent acted.", body: "The decision and its stated rationale, connected to the context and checks that came before it.", fields: ["Action intent", "Stated rationale", "Decision time"] },
  { name: "Reported outcome", code: "JOURNAL", title: "What happened next.", body: "The result reported by the agent, with its source and limits visible alongside the original decision.", fields: ["Reported result", "Record source", "Known limitations"] },
];

export default function FlightRecorder() {
  const section = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const reduced = useReducedMotion();
  const inView = useInView(section, { margin: "200px 0px 200px 0px" });
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [failed, setFailed] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string>();
  const [requested, setRequested] = useState(false);
  const [settled, setSettled] = useState(Boolean(reduced));
  const { scrollYProgress } = useScroll({ target: section, offset: ["start end", "end end"] });
  const side = useTransform(scrollYProgress, [0.32, 0.6], ["0%", "3.84%"]);
  const vertical = useTransform(scrollYProgress, [0.32, 0.6], ["0%", "7%"]);
  const fade = useTransform(scrollYProgress, [0.04, 0.24, 0.55, 1], [0, 1, 1, 0.8]);
  const contentFade = useTransform(scrollYProgress, [0.42, 0.6], [0, 1]);
  const cueFade = useTransform(scrollYProgress, [0.4, 0.58], [1, 0]);

  useMotionValueEvent(scrollYProgress, "change", (progress) => {
    setSettled(progress > 0.5);
  });

  useEffect(() => { if (inView && !reduced) setRequested(true); }, [inView, reduced]);
  useEffect(() => {
    if (!requested || reduced) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    // The unchanged imported server does not support media range requests.
    // A local Blob gives the short clip reliable seeking without server edits.
    fetch(`${media}eko-flight-recorder-1080p.mp4`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error("Video unavailable"); return response.blob(); })
      .then(blob => { if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setVideoUrl(objectUrl); } })
      .catch(error => { if (error.name !== "AbortError") setFailed(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [requested, reduced]);

  useEffect(() => {
    const element = video.current;
    if (!element || !videoUrl) return;
    let disposed = false;
    const play = () => element.play().catch((error: DOMException) => {
      if (!disposed && error.name !== "AbortError") setPaused(true);
    });
    if (inView && !paused && !reduced && !document.hidden) {
      play();
    } else element.pause();
    const visibility = () => {
      if (document.hidden) element.pause();
      else if (inView && !paused && !reduced) play();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => { disposed = true; document.removeEventListener("visibilitychange", visibility); };
  }, [inView, paused, reduced, videoUrl]);

  function selectEntry(index: number) {
    setActive(index);
    setPaused(true);
    if (video.current && video.current.readyState >= 1) video.current.currentTime = [0.1, 3.6, 7.1, 11.1][index];
  }

  function viewJournal() {
    const el = section.current;
    if (!el) return;
    window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top + el.offsetHeight - window.innerHeight, behavior: reduced ? "instant" : "smooth" });
  }

  return (
    <section id="flight-recorder" ref={section} className="fr-section" aria-labelledby="recorder-heading">
      <div className="fr-stage">
        <motion.div className="fr-screen" style={reduced ? undefined : { left: side, right: side, top: vertical, bottom: vertical }}>
          <motion.div className="fr-footage" style={reduced ? undefined : { opacity: fade }}>
            <video ref={video} src={videoUrl} poster={`${media}eko-flight-recorder-poster.webp`} muted loop playsInline preload="metadata" aria-hidden="true" onLoadedData={() => setFailed(false)} onTimeUpdate={() => { if (!paused && video.current) { const t = video.current.currentTime; setActive(t < 3.5 ? 0 : t < 7 ? 1 : t < 11 ? 2 : 3); } }} onError={() => setFailed(true)} />
          </motion.div>
          <div className="fr-shade" />
          <div className="fr-scanlines" aria-hidden="true" />
          <motion.div className="fr-entry" style={reduced ? { display: "none" } : { opacity: cueFade }} inert={settled} aria-hidden={settled}>
            <span className="eko-label"><i />04 / Flight Recorder</span>
            <p>Every decision.<br /><span>A trace.</span></p>
            <button onClick={viewJournal}>Scroll to follow the trail <span>↓</span></button>
          </motion.div>
          <motion.div className="fr-content" style={reduced ? undefined : { opacity: contentFade }} inert={!reduced && !settled} aria-hidden={!reduced && !settled}>
            <div className="fr-topline"><span className="eko-label"><i />04 / Flight Recorder</span><span className="eko-status">Planned</span><span className="fr-private">◇ Private by design</span></div>
            <div className="fr-story">
              <div className="fr-intro"><h2 id="recorder-heading">A decision should<br /><span>leave a trail.</span></h2><p>Context. Policy. Intent. Outcome.<br />One connected decision journal.</p></div>
              <div className="fr-record" key={active} role="region" aria-label={`${entries[active].name} journal example`} aria-live={paused ? "polite" : "off"}>
                <span className="eko-mono">RECORD / 0{active + 1} <i /> {entries[active].code}</span>
                <h3>{entries[active].title}</h3><p>{entries[active].body}</p>
                <ul>{entries[active].fields.map(field => <li key={field}><span>↳</span>{field}</li>)}</ul>
              </div>
            </div>
            <div className="fr-controls" role="group" aria-label="Explore the decision journal">
              {entries.map((entry, index) => <button key={entry.code} onClick={() => selectEntry(index)} aria-pressed={active === index}><span className="fr-tab-code">0{index + 1}<i>{entry.code}</i><b aria-hidden="true">{active === index ? "−" : "+"}</b></span><span>{entry.name}</span></button>)}
            </div>
            <div className="fr-bottom"><p>Illustrative journal · Agent-reported outcomes may be incomplete.</p><button disabled={Boolean(reduced) || failed} onClick={() => setPaused(!paused)} aria-label={paused ? "Play recorder background" : "Pause recorder background"}>{reduced ? "Still frame" : failed ? "Still frame" : paused ? "Play motion ▷" : "Pause motion Ⅱ"}</button></div>
          </motion.div>
          <span className="fr-corner fr-corner-a" aria-hidden="true">+</span><span className="fr-corner fr-corner-b" aria-hidden="true">+</span>
        </motion.div>
      </div>
    </section>
  );
}
