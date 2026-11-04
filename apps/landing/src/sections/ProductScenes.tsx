import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import { radarProfiles, Sparkline, Verdict } from "./EkoDashboard";
import ekoMark from "../assets/eko-mark.svg";
import "./product-scenes.css";

const sample = radarProfiles.find((p) => p.symbol === "GHOST")!;
const appear = {
  hidden: { opacity: 0, y: 36, filter: "blur(7px)" },
  visible: { opacity: 1, y: 0, filter: "blur(0px)" },
};
function Scene({
  id,
  number,
  label,
  title,
  description,
  planned,
  children,
  footnote,
}: {
  id: string;
  number: string;
  label: string;
  title: ReactNode;
  description: string;
  planned?: boolean;
  children: ReactNode;
  footnote: string;
}) {
  const ref = useRef<HTMLElement>(null),
    inView = useInView(ref, { amount: 0.12 });
  const [paused, setPaused] = useState(false),
    reduced = useReducedMotion();
  return (
    <section
      ref={ref}
      id={id}
      className="eko-section eko-frame ps-scene"
      data-motion={inView && !paused && !reduced ? "on" : "off"}
    >
      <div className="eko-section-head">
        <div className="eko-head-label">
          <span className="eko-label">
            <i />
            {number} / {label}
          </span>
          {planned && <span className="eko-status">Planned</span>}
          <button
            className="ps-motion-toggle"
            type="button"
            aria-label={`${paused ? "Play" : "Pause"} ${label} animations`}
            aria-pressed={paused || !!reduced}
            disabled={!!reduced}
            onClick={() => setPaused((p) => !p)}
          >
            {paused || reduced ? "▶ Visuals paused" : "Ⅱ Pause visuals"}
          </button>
        </div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <motion.div
        className="ps-body"
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount: 0.1 }}
        transition={{ staggerChildren: 0.14 }}
      >
        {children}
      </motion.div>
      <p className="ps-footnote">{footnote}</p>
    </section>
  );
}
function Orb({ small = false }: { small?: boolean }) {
  return (
    <span className={`ps-orb ${small ? "small" : ""}`} aria-hidden="true">
      <img src={ekoMark} alt="" />
    </span>
  );
}
function WindowBar({
  title,
  badge = "Sample",
}: {
  title: string;
  badge?: string;
}) {
  return (
    <div className="ps-windowbar">
      <Orb small />
      <span>{title}</span>
      <small>{badge}</small>
      <span className="ps-window-dots" aria-hidden="true">
        ···
      </span>
    </div>
  );
}
function Wave({ values = sample.series }: { values?: number[] }) {
  return (
    <div className="ps-wave" aria-hidden="true">
      {values.map((value, i) => (
        <i
          key={i}
          style={
            {
              height: `${12 + value * 0.76}%`,
              "--delay": `${i * -0.11}s`,
            } as CSSProperties
          }
        />
      ))}
      <b />
    </div>
  );
}
function Feature({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li>
      <span aria-hidden="true">✳</span>
      <div>
        <h4>{title}</h4>
        <p>{children}</p>
      </div>
    </li>
  );
}

export function Senses() {
  const [symbol, setSymbol] = useState("GHOST"),
    [depth, setDepth] = useState("Liquidity"),
    [context, setContext] = useState("Context");
  const coin = radarProfiles.find((p) => p.symbol === symbol)!;
  return (
    <Scene
      id="senses"
      number="01"
      label="Senses"
      title={
        <>
          See what price
          <br />
          leaves out.
        </>
      }
      description="Follow the participants, read the liquidity, and understand the reasons behind a signal."
      footnote="Illustrative cards use the imported terminal’s frozen sample data. Signal and wallet classifications are beta; they do not establish certainty."
    >
      <div className="ps-senses-grid">
        <motion.article
          variants={appear}
          transition={{ duration: 0.7 }}
          className="ps-glass ps-sense-card ps-flow-card"
        >
          <WindowBar title="Wallet activity" />
          <p className="ps-card-description">
            A market moves. Start with who is moving it.
          </p>
          <div
            className="ps-pills"
            role="group"
            aria-label="Wallet sample token"
          >
            {["GHOST", "ORBIT", "FROG"].map((s) => (
              <button
                type="button"
                key={s}
                aria-pressed={symbol === s}
                onClick={() => setSymbol(s)}
              >
                ${s}
              </button>
            ))}
          </div>
          <Wave values={coin.series} />
          <div className="ps-flow-total">
            <strong>
              {Math.round((coin.flow.agent + coin.flow.likely) * 100)}
              <small>%</small>
            </strong>
            <span>
              Agent-labelled activity
              <small>1h window · Beta classification</small>
            </span>
          </div>
          <div className="ps-participants">
            <div>
              <i style={{ width: `${coin.flow.agent * 100}%` }} />
              <i style={{ width: `${coin.flow.likely * 100}%` }} />
              <i style={{ width: `${coin.flow.crew * 100}%` }} />
              <i style={{ width: `${coin.flow.human * 100}%` }} />
            </div>
            <span>Declared</span>
            <span>Likely</span>
            <span>Crew</span>
            <span>Human</span>
          </div>
          <div className="ps-card-bottom">
            <Orb small />
            <span>Participation gives the move context.</span>
            <span className="ps-live-glyph" aria-hidden="true">
              ✳
            </span>
          </div>
        </motion.article>
        <motion.article
          variants={appear}
          transition={{ duration: 0.7, delay: 0.12 }}
          className="ps-glass ps-sense-card ps-depth-card"
        >
          <WindowBar title="Market depth" />
          <p className="ps-card-description">
            Look beneath the chart, then model the way out.
          </p>
          <div
            className="ps-pills"
            role="group"
            aria-label="Market depth perspective"
          >
            {["Liquidity", "Exit costs"].map((s) => (
              <button
                type="button"
                key={s}
                aria-pressed={depth === s}
                onClick={() => setDepth(s)}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="ps-depth-window" aria-live="polite">
            <div className="ps-depth-heading">
              <span>
                ${coin.symbol} / {depth}
              </span>
              <span>↗</span>
            </div>
            {depth === "Liquidity" ? (
              <>
                <strong>
                  ${(coin.liquidity / 1000).toFixed(0)}
                  <small>K</small>
                </strong>
                <span className="ps-muted">Sample liquidity</span>
                <svg
                  className="ps-depth-chart"
                  viewBox="0 0 300 110"
                  aria-hidden="true"
                >
                  <path
                    d="M0 106 L0 93 L30 93 L30 82 L60 82 L60 70 L90 70 L90 67 L120 67 L120 54 L150 54 L150 45 L180 45 L180 26 L210 26 L210 16 L240 16 L240 8 L300 8 L300 106Z"
                    fill="#8fcaf018"
                  />
                  <path
                    className="ps-chart-trace"
                    d="M0 93 H30 V82 H60 V70 H90 V67 H120 V54 H150 V45 H180 V26 H210 V16 H240 V8 H300"
                    fill="none"
                    stroke="#8fcaf0"
                    strokeWidth="1.4"
                    pathLength="1"
                  />
                </svg>
              </>
            ) : (
              <div className="ps-exit-table">
                {(["100", "1000", "10000"] as const).map((size) => (
                  <div key={size}>
                    <span>${Number(size).toLocaleString()}</span>
                    <b>
                      {coin.exit[size] === null
                        ? "Blocked"
                        : `${coin.exit[size]}%`}
                    </b>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="ps-card-bottom">
            <span className="ps-ring-glyph" aria-hidden="true">
              ◎
            </span>
            <span>
              {depth === "Liquidity"
                ? "Depth is context. Size still matters."
                : "A simulation, not an execution quote."}
            </span>
          </div>
        </motion.article>
        <motion.article
          variants={appear}
          transition={{ duration: 0.7, delay: 0.24 }}
          className="ps-glass ps-sense-card ps-context-card"
        >
          <WindowBar title="Signal context" badge="Beta" />
          <p className="ps-card-description">
            A reading is useful when you can inspect its reasons.
          </p>
          <div
            className="ps-pills"
            role="group"
            aria-label="Signal perspective"
          >
            {["Context", "Risk patterns"].map((s) => (
              <button
                type="button"
                key={s}
                aria-pressed={context === s}
                onClick={() => setContext(s)}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="ps-context-banner">
            <Orb small />
            <span>
              ${coin.symbol}
              <b>{coin.composite} / 100</b>
            </span>
            <Verdict value={coin.verdict} />
          </div>
          <div className="ps-context-report" aria-live="polite">
            <span className="ps-reading-status">
              <i />
              {context === "Context"
                ? "Reading the evidence"
                : "Matched risk patterns"}
            </span>
            <p>
              {context === "Context"
                ? coin.summary
                : coin.matches[0]?.history ||
                  "No risk pattern matched in this sample."}
            </p>
            <div className="ps-evidence-lines">
              <span>
                <i />
                {context === "Context"
                  ? "Wallet participation"
                  : "Known playbooks"}
                <b>Reviewed</b>
              </span>
              <span>
                <i />
                {context === "Context"
                  ? "Liquidity and exit costs"
                  : "Guard verdict"}
                <b>{context === "Context" ? "Simulated" : coin.verdict}</b>
              </span>
              <span>
                <i />
                {context === "Context"
                  ? "Reading freshness"
                  : "Supporting reasons"}
                <b>Recorded</b>
              </span>
            </div>
          </div>
          <a
            href={`/coin/${coin.address}`}
            className="ps-card-bottom ps-card-link"
          >
            <span>Read the sample evidence</span>
            <span>↗</span>
          </a>
        </motion.article>
      </div>
    </Scene>
  );
}

export function Harness() {
  const [limit, setLimit] = useState(5),
    [approval, setApproval] = useState(true);
  const exceeds = 7 > limit;
  const decision = exceeds
    ? "Review required"
    : approval
      ? "Approval selected"
      : "Within sample limit";
  return (
    <Scene
      id="harness"
      number="02"
      label="Agent harness"
      title={
        <>
          Your agent.
          <br />
          Your rules.
        </>
      }
      description="Set the boundaries before the next action. Put context, policies and human approval in the same workspace."
      planned
      footnote="Interactive example. External-agent preflight checks are advisory; enforcement depends on the execution setup. These controls do not change an agent or account."
    >
      <div className="ps-feature-layout">
        <motion.div
          variants={appear}
          transition={{ duration: 0.85 }}
          className="ps-stage ps-policy-stage"
        >
          <div className="ps-stage-tags">
            <span>Position limits</span>
            <span>Approval policy</span>
            <span>+ Context</span>
          </div>
          <div className="ps-glass ps-policy-base ps-floating">
            <WindowBar title="EKO agent / policy workspace" badge="Draft" />
            <div className="ps-policy-columns">
              <aside>
                <span>◎ Overview</span>
                <span>◈ Senses</span>
                <span className="active">⊞ Policies</span>
                <span>◇ Approvals</span>
                <span>↳ Journal</span>
              </aside>
              <div>
                <small>CONNECTED CONTEXT</small>
                <div className="ps-input-row">
                  <span>Wallet activity</span>
                  <b>↗</b>
                </div>
                <div className="ps-input-row">
                  <span>Market conditions</span>
                  <b>↗</b>
                </div>
                <div className="ps-input-row">
                  <span>Exit simulation</span>
                  <b>↗</b>
                </div>
              </div>
            </div>
          </div>
          <motion.div
            variants={appear}
            transition={{ duration: 0.75, delay: 0.25 }}
            className="ps-glass ps-policy-front"
          >
            <div className="ps-policy-title">
              <span className="ps-policy-icon" aria-hidden="true">
                ◇
              </span>
              <div>
                <h3>Position policy</h3>
                <small>Check before action</small>
              </div>
              <span className="ps-tag">Sample</span>
            </div>
            <label className="ps-limit-label" htmlFor="position-limit">
              Position limit <output>{limit}%</output>
            </label>
            <input
              id="position-limit"
              type="range"
              min="1"
              max="10"
              step="1"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
            <div className="ps-limit-scale">
              <span>1%</span>
              <span>10%</span>
            </div>
            <div className="ps-request-row">
              <span>Sample requested position</span>
              <b>7%</b>
            </div>
            <label className="ps-approval">
              Human approval{" "}
              <input
                type="checkbox"
                checked={approval}
                onChange={(e) => setApproval(e.target.checked)}
              />
              <span className="ps-switch" aria-hidden="true" />
            </label>
          </motion.div>
          <motion.div
            variants={appear}
            transition={{ duration: 0.7, delay: 0.4 }}
            className="ps-glass ps-policy-receipt"
            aria-live="polite"
          >
            <span className="ps-receipt-icon" aria-hidden="true">
              {exceeds || approval ? "◇" : "✓"}
            </span>
            <div>
              <small>PREFLIGHT / EXAMPLE</small>
              <strong>{decision}</strong>
              <p>
                {exceeds
                  ? `The sample position exceeds your ${limit}% limit.`
                  : approval
                    ? "The position fits; a human review is selected."
                    : "The position fits your selected limit."}
              </p>
            </div>
          </motion.div>
          <div className="ps-stage-floor" aria-hidden="true" />
        </motion.div>
        <motion.div
          variants={appear}
          transition={{ duration: 0.75, delay: 0.18 }}
          className="ps-feature-copy"
        >
          <span className="ps-eyebrow">BOUNDARIES BEFORE EXECUTION</span>
          <h3>
            Give every action
            <br />a clear boundary.
          </h3>
          <ul>
            <Feature title="Define the policy.">
              Position limits, blocked assets and approval thresholds make your
              intent explicit.
            </Feature>
            <Feature title="Inspect the reason.">
              Know which policy was checked and why an action needs attention.
            </Feature>
            <Feature title="Keep people in the loop.">
              Review decisions with their context, before the next step.
            </Feature>
          </ul>
          <a href="#flight-recorder" className="eko-text-link">
            Follow the decision trail <span>↗</span>
          </a>
        </motion.div>
      </div>
    </Scene>
  );
}

const stages = [
  {
    name: "Define",
    title: "Make the rules explicit.",
    description:
      "Start with entries, exits and a cost model. Every assumption belongs in the open.",
    state: "RULESET / DRAFT",
    label: "Your assumptions",
    detail: "Entry rules · Exit rules · Cost model",
  },
  {
    name: "Replay",
    title: "Watch the conditions change.",
    description:
      "Follow a sample market path and see where the rules would need to be evaluated.",
    state: "REPLAY / ILLUSTRATION",
    label: "Follow the sequence",
    detail: "Context → Entry check → Exit check",
  },
  {
    name: "Inspect",
    title: "Understand the trade-offs.",
    description:
      "Review the assumptions and simulated costs behind each step before refining a strategy.",
    state: "REVIEW / ASSUMPTIONS",
    label: "Inspect each decision",
    detail: "Rule matched · Cost considered · Reason retained",
  },
];
export function LoopLab() {
  const [step, setStep] = useState(0),
    current = stages[step];
  return (
    <Scene
      id="loop-lab"
      number="03"
      label="Loop Lab"
      title={
        <>
          Test the rules.
          <br />
          See the trade-offs.
        </>
      }
      description="Move from an idea to a set of explicit rules, with the assumptions and costs visible at every step."
      planned
      footnote="This is an interactive workflow illustration, not a running backtest or performance result. Historical results do not predict future performance."
    >
      <div className="ps-feature-layout ps-loop-layout">
        <motion.div
          variants={appear}
          transition={{ duration: 0.75 }}
          className="ps-feature-copy"
        >
          <span className="ps-eyebrow">STRATEGY / REPLAY / REVIEW</span>
          <h3>
            A strategy deserves
            <br />a closer look.
          </h3>
          <div
            className="ps-stage-switch"
            role="group"
            aria-label="Explore replay stages"
          >
            {stages.map((stage, i) => (
              <button
                type="button"
                key={stage.name}
                aria-pressed={step === i}
                onClick={() => setStep(i)}
              >
                <span>0{i + 1}</span>
                {stage.name}
              </button>
            ))}
          </div>
          <div className="ps-stage-description" aria-live="polite">
            <h4>{current.title}</h4>
            <p>{current.description}</p>
          </div>
          <a href="#flight-recorder" className="eko-text-link">
            Keep the reasons <span>↗</span>
          </a>
        </motion.div>
        <motion.div
          variants={appear}
          transition={{ duration: 0.85, delay: 0.15 }}
          className={`ps-stage ps-replay-stage ps-step-${step}`}
        >
          <div className="ps-glass ps-replay-base ps-floating">
            <WindowBar title="EKO / strategy workspace" badge="Loop Lab" />
            <div className="ps-replay-head">
              <h3>Replay</h3>
              <span>Rules</span>
              <span>Journal</span>
            </div>
            <div className="ps-replay-sidebar">
              <small>ASSUMPTIONS</small>
              <span>01 Entry conditions</span>
              <span>02 Position rules</span>
              <span>03 Exit conditions</span>
              <span>04 Cost model</span>
            </div>
            <div className="ps-replay-plot">
              <span>Sample market path</span>
              <Sparkline values={sample.series} />
              <div className="ps-plot-scan" aria-hidden="true" />
              <div className="ps-plot-axis">
                <span>CONTEXT</span>
                <span>ENTRY</span>
                <span>EXIT</span>
              </div>
            </div>
          </div>
          <motion.div
            key={step}
            initial={{ opacity: 0, y: 18, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.45 }}
            className="ps-glass ps-replay-front"
          >
            <div className="ps-replay-front-head">
              <Orb small />
              <span>{current.state}</span>
              <span>↗</span>
            </div>
            <h4>{current.label}</h4>
            <div className="ps-replay-progress">
              <span style={{ width: `${((step + 1) / 3) * 100}%` }} />
            </div>
            <p>{current.detail}</p>
            <div className="ps-replay-checks">
              <span>✓ Context retained</span>
              <span>✓ Costs visible</span>
            </div>
          </motion.div>
          <div className="ps-replay-badge">
            <span aria-hidden="true">✳</span> Clear rules. Traceable decisions.
          </div>
          <div className="ps-stage-floor" aria-hidden="true" />
        </motion.div>
      </div>
    </Scene>
  );
}
