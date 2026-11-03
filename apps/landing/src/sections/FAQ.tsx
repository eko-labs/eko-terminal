import { useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import ekoMark from "../assets/eko-mark.svg";
import "./bento-system.css";
import "./faq.css";

// Answers adapted from the supplied EKO Overview. Availability is not inferred
// from the product plan; the preview and planned capabilities stay explicit.
const questions = [
  { question: "What is EKO?", category: "THE BASICS", answer: "EKO is the harness your trading agent plugs into: market context through Senses, policy checks through Guardrails, strategy testing in Loop Lab and a decision journal in Flight Recorder. Mission Control brings that activity into a workspace you supervise. Its first application is a trench terminal for Elysium that scans new Pons launches and Uniswap pools for scam playbooks.", link: "Explore Senses", href: "#senses" },
  { question: "Do I need an agent to use EKO?", category: "GETTING STARTED", answer: "You can explore market context yourself through the terminal—Radar, token readings, wallet activity and risk patterns. An agent connects to the harness separately when you want those readings and checks inside its workflow. The terminal reads live Elysium data; the previews on this page use sample data.", link: "Open the terminal", href: "/radar" },
  { question: "Who controls the agent and the funds?", category: "OWNERSHIP", answer: "You do. EKO’s design is non-custodial: your agent operates in your environment and executes through your own account or wallet. EKO provides context, checks and oversight without holding your private keys or venue credentials. The planned Agent Launcher follows the same model.", link: "Explore the harness", href: "#harness" },
  { question: "Can Guardrails stop every order?", category: "POLICIES", answer: "For external agents, preflight is advisory: it checks an order against your policy and returns allow, deny or needs approval, with reasons. It cannot stop an external agent that ignores the check. On-chain enforcement through session keys is planned and depends on the policy module’s review and release.", link: "See the policy example", href: "#harness" },
  { question: "What does Loop Lab test?", category: "RESEARCH", answer: "The planned workflow turns a strategy into explicit rules and replays them on historical, point-in-time data with assumptions and costs visible. Loop Lab Pro adds shadow runs, stress scenarios and model comparisons. A replay describes a past scenario; it is not a promise of future performance.", link: "Explore Loop Lab", href: "#loop-lab" },
  { question: "Is my decision journal public?", category: "PRIVACY", answer: "Flight Recorder is designed as a private, encrypted journal. Its public proof uses salted hashes—fingerprints of records—rather than publishing the entries themselves. You choose what to reveal. Reported outcomes and unchecked-order detection rely on what your agent reports, so they can be incomplete.", link: "Explore Flight Recorder", href: "#flight-recorder" },
  { question: "What do the beta labels mean?", category: "READING THE SIGNAL", answer: "Agent classifications and market signals are estimates with limitations, not statements of certainty. Read their evidence, confidence and freshness alongside the headline. A No flags reading means no covered risk pattern was found in that reading; it does not make an asset risk-free.", link: "Follow the evidence", href: "#discover" },
  { question: "Are all roadmap features available?", category: "WHAT’S NEXT", answer: "No. The roadmap describes planned releases, and the interactive landing examples illustrate the intended workflows. Each drop depends on its recorded demo, evaluation checks and release notes. Scope and timing can change; a planned label does not mean a feature has shipped.", link: "Explore the roadmap", href: "#roadmap" },
];

export default function FAQ() {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { once: true, amount: .1 });
  const reduced = useReducedMotion();
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section ref={ref} id="faq" className="bento-section faq-section" aria-labelledby="faq-heading">
      <div className="faq-layout">
        <header className="bento-heading faq-heading">
          <span className="bento-badge"><i />The EKO field guide</span>
          <h2 id="faq-heading">Good questions.<br /><span className="bento-muted">Clear answers.</span></h2>
          <p>A closer look at the system,<br />and your place in it.</p>
          <div className="faq-art" aria-hidden="true"><span className="faq-bracket" /><span className="faq-question-mark">?</span><img src={ekoMark} alt="" /><span className="faq-art-caption">CONTEXT BEFORE ACTION</span></div>
          <a className="faq-terminal" href="/radar">Explore the terminal <span>↗</span></a>
        </header>
        <div className="faq-questions">
          {questions.map((item, index) => <motion.article className="faq-item" data-open={open === index} key={item.question}
            initial={{ opacity: 0, y: reduced ? 0 : 14 }} animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: reduced ? 0 : 14 }} transition={{ duration: .5, delay: index * .05 }}>
            <h3><button id={`faq-question-${index}`} aria-expanded={open === index} aria-controls={`faq-answer-${index}`} onClick={() => setOpen(open === index ? null : index)}><span className="faq-number">{String(index + 1).padStart(2, "0")}</span><span>{item.question}</span><span className="faq-plus" aria-hidden="true"><i /><i /></span></button></h3>
            <div id={`faq-answer-${index}`} className="faq-answer" role="region" aria-labelledby={`faq-question-${index}`} aria-hidden={open !== index} inert={open !== index}>
              <div><div className="faq-answer-content"><span className="bento-kicker">{item.category}</span><p>{item.answer}</p><a href={item.href}>{item.link}<span>↗</span></a></div></div>
            </div>
          </motion.article>)}
        </div>
      </div>
      <div className="bento-comb" aria-hidden="true" />
    </section>
  );
}
