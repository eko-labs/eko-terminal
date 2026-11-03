import { useEffect, useRef, useState, type ReactNode } from "react";
import { useInView, useReducedMotion } from "framer-motion";
import FlowGradient from "../lib/FlowGradient";
import { AnimatedLines } from "../lib/animations";
import ekoMark from "../assets/eko-mark.svg";

const arrow = <span aria-hidden="true">↗</span>;
function Label({ children }: { children: ReactNode }) {
  return (
    <span className="eko-label">
      <i />
      {children}
    </span>
  );
}
function Heading({
  number,
  name,
  title,
  description,
  planned = false,
}: {
  number: string;
  name: string;
  title: string[];
  description: string;
  planned?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    visible = useInView(ref, { once: true, amount: 0.15 });
  return (
    <div className="eko-section-head" ref={ref}>
      <div className="eko-head-label">
        <Label>
          {number} / {name}
        </Label>
        {planned && <span className="eko-status">Planned</span>}
      </div>
      <AnimatedLines as="h2" lines={title} isInView={visible} />
      <p>{description}</p>
    </div>
  );
}

/** New decorative graphics, separate from the original DISCOVER animation. */
function SignalField({
  mode = "field",
  intensity = 1,
}: {
  mode?: "field" | "terrain" | "orbit";
  intensity?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null),
    reduced = useReducedMotion();
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let w = 600,
      h = 400,
      frame = 0,
      visible = false,
      last = 0;
    const pointer = { x: -999, y: -999 };
    function draw(t: number) {
      ctx!.clearRect(0, 0, w, h);
      const time = reduced ? 0 : t * 0.0002,
        pitch = w < 420 ? 10 : 12;
      for (let row = 0; row < h / pitch; row++)
        for (let col = 0; col < w / pitch; col++) {
          let x = col * pitch,
            y = row * pitch,
            alpha = 0.08,
            r = 1;
          const nx = x / w,
            ny = y / h;
          if (mode === "terrain") {
            const ridge =
                Math.sin(nx * 9 + time) * 0.12 +
                Math.sin(nx * 20 - time * 0.6) * 0.04,
              depth = Math.pow(ny, 1.5);
            y = h * (0.3 + depth * 0.58 + ridge * (1 - depth));
            x = w * 0.5 + (x - w * 0.5) * (0.35 + depth * 0.8);
            alpha =
              (0.2 + depth * 0.6) *
              (Math.sin(nx * 8 + ny * 9 + time) * 0.25 + 0.75);
            r = 0.7 + depth;
          } else if (mode === "orbit") {
            const d = Math.hypot((nx - 0.5) * 1.35, ny - 0.5);
            alpha = Math.max(0.03, 0.7 - Math.abs(Math.sin(d * 26 - time)) * 2);
            r = 1.2;
          } else {
            const wave =
              Math.sin(nx * 7 + ny * 4 + time) +
              Math.cos(ny * 9 - nx * 3 - time * 0.6);
            alpha = Math.max(
              0.03,
              (wave * 0.3 + 0.23) * Math.exp(-Math.pow((ny - 0.5) * 2.1, 2)),
            );
            r = 1 + (wave + 2) * 0.4;
            if ((col * 13 + row * 7) % 29 === 0 && alpha > 0.28) {
              ctx!.fillStyle = `rgba(143,202,240,${alpha * 0.7})`;
              ctx!.font = "9px monospace";
              ctx!.fillText("01+/:x"[(col + row) % 6], x, y);
              continue;
            }
          }
          const dist = Math.hypot(x - pointer.x, y - pointer.y);
          if (dist < 90) {
            alpha += 0.3 * (1 - dist / 90);
            r += 1 - dist / 90;
          }
          ctx!.fillStyle = `rgba(143,202,240,${Math.min(0.95, alpha * intensity)})`;
          ctx!.fillRect(x, y, r, r);
        }
    }
    const size = new ResizeObserver(([entry]) => {
      w = entry.contentRect.width;
      h = entry.contentRect.height;
      const dpr = Math.min(devicePixelRatio, 2);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(0);
    });
    const run = (t: number) => {
      if (visible && t - last > 40) {
        draw(t);
        last = t;
      }
      frame = requestAnimationFrame(run);
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && reduced) draw(0);
    });
    const move = (event: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      pointer.x = event.clientX - r.left;
      pointer.y = event.clientY - r.top;
    };
    const leave = () => {
      pointer.x = -999;
      pointer.y = -999;
    };
    size.observe(canvas);
    observer.observe(canvas);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerleave", leave);
    if (!reduced) frame = requestAnimationFrame(run);
    return () => {
      size.disconnect();
      observer.disconnect();
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
    };
  }, [mode, intensity, reduced]);
  return <canvas ref={ref} className="eko-field" aria-hidden="true" />;
}

export function StoryEntry() {
  // EKO_SITE's source is absent from the supplied archive. Preserve access to the actual experience.
  return (
    <section
      id="discover"
      className="eko-story-entry eko-frame"
      aria-labelledby="story-title"
    >
      <div>
        <Label>EKO / THE SIGNAL STORY</Label>
        <h2 id="story-title">
          Follow one token.
          <br />
          See how a signal forms.
        </h2>
      </div>
      <div>
        <p>
          Every move has a cause. Enter EKO's original DISCOVER experience and
          follow the reading from activity to signal.
        </p>
        <a
          className="eko-text-link"
          href="/"
        >
          Enter the original experience {arrow}
        </a>
      </div>
    </section>
  );
}
const readings = [
  {
    name: "Wallet activity",
    code: "FLOW",
    heading: "Follow the participants.",
    body: "Activity becomes more useful when you can see who is moving, how often, and in which direction.",
    detail: "Wallet labels · Activity patterns · Context",
  },
  {
    name: "Liquidity",
    code: "DEPTH",
    heading: "Look beneath the surface.",
    body: "A price is one observation. Liquidity adds context to the conditions around a potential move.",
    detail: "Pool depth · Concentration · Market context",
  },
  {
    name: "Exit costs",
    code: "EXIT",
    heading: "Account for the way out.",
    body: "Simulated exit costs help make the gap between a displayed price and a possible outcome visible.",
    detail: "Simulation · Slippage · Cost assumptions",
  },
  {
    name: "Risk patterns",
    code: "RISK",
    heading: "Recognise the pattern.",
    body: "Recognised risk patterns add another perspective. A reading should come with reasons you can inspect.",
    detail: "Pattern checks · Evidence · Limitations",
  },
  {
    name: "Signal context",
    code: "SIGNAL",
    heading: "Read the reasons.",
    body: "No flags, Monitor or Danger is a starting point. Follow the context behind the reading before deciding what comes next.",
    detail: "Verdict · Confidence · Freshness",
  },
];
export function Senses() {
  const [active, setActive] = useState(0),
    reading = readings[active];
  return (
    <section id="senses" className="eko-section eko-frame">
      <Heading
        number="01"
        name="Senses"
        title={["See what price", "leaves out."]}
        description="Wallet activity, liquidity, recognised risk patterns and simulated exit costs bring context to the chart."
      />
      <div className="eko-evidence">
        <div
          className="eko-evidence-tabs"
          role="tablist"
          aria-label="Evidence perspectives"
          aria-orientation="vertical"
        >
          {readings.map((item, index) => (
            <button
              key={item.code}
              id={`evidence-tab-${index}`}
              role="tab"
              aria-selected={active === index}
              aria-controls="evidence-panel"
              tabIndex={active === index ? 0 : -1}
              onClick={() => setActive(index)}
              onKeyDown={(event) => {
                let n = index;
                if (event.key === "ArrowDown" || event.key === "ArrowRight")
                  n = (index + 1) % readings.length;
                else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
                  n = (index + readings.length - 1) % readings.length;
                else if (event.key === "Home") n = 0;
                else if (event.key === "End") n = readings.length - 1;
                else return;
                event.preventDefault();
                setActive(n);
                document.getElementById(`evidence-tab-${n}`)?.focus();
              }}
            >
              <span className="eko-mono">0{index + 1}</span>
              {item.name}
              <span aria-hidden="true">{active === index ? "↗" : "+"}</span>
            </button>
          ))}
        </div>
        <div
          className="eko-evidence-display"
          id="evidence-panel"
          role="tabpanel"
          aria-labelledby={`evidence-tab-${active}`}
          tabIndex={0}
        >
          <div className="eko-data-top">
            <span>INPUT / {reading.code}</span>
            <span>PRODUCT ILLUSTRATION</span>
          </div>
          <SignalField intensity={0.65 + active * 0.12} />
          <div className="eko-evidence-copy" key={active}>
            <span className="eko-mono">EKO / READING 0{active + 1}</span>
            <h3>{reading.heading}</h3>
            <p>{reading.body}</p>
            <span className="eko-detail">{reading.detail}</span>
          </div>
          <div className="eko-data-bottom">
            <span>CONTEXT BEFORE CONVICTION</span>
            <span>+ + +</span>
          </div>
        </div>
      </div>
      <div className="eko-section-tail">
        <p>A signal forms. Certainty doesn't.</p>
        <a href="/radar" className="eko-text-link">
          Explore the terminal {arrow}
        </a>
      </div>
    </section>
  );
}
export function Harness() {
  const [cap, setCap] = useState(5),
    [approval, setApproval] = useState(true),
    requested = 7;
  return (
    <section id="harness" className="eko-section eko-frame">
      <Heading
        number="02"
        name="Agent harness"
        title={["Your agent.", "Your rules."]}
        description="Define the boundaries before the next action. Position limits, blocked assets and approval thresholds, with a reason behind each policy check."
        planned
      />
      <div className="eko-harness-grid">
        <article className="eko-harness-card">
          <span className="eko-mono">01 / CONTEXT</span>
          <h3>Senses</h3>
          <p>Context before action.</p>
          <div className="eko-rings" aria-hidden="true">
            <i />
            <i />
            <i />
            <img src={ekoMark} alt="" />
          </div>
          <ul>
            {[
              "Wallet activity",
              "Market context",
              "Simulated exit costs",
              "Verdict reasons",
            ].map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <a className="eko-button" href="#senses">
            Explore signals {arrow}
          </a>
        </article>
        <article className="eko-harness-card eko-policy-card">
          <FlowGradient />
          <div className="eko-policy-content">
            <div className="eko-card-top">
              <span className="eko-mono">02 / BOUNDARIES</span>
              <span className="eko-status">INTERACTIVE EXAMPLE</span>
            </div>
            <h3>Guardrails</h3>
            <p>Boundaries before execution.</p>
            <div className="eko-policy-box">
              <label htmlFor="position-limit">
                Position limit <output htmlFor="position-limit">{cap}%</output>
              </label>
              <input
                id="position-limit"
                type="range"
                min="1"
                max="10"
                value={cap}
                onChange={(e) => setCap(Number(e.target.value))}
              />
              <div className="eko-policy-row">
                <span>Example requested position</span>
                <span>{requested}%</span>
              </div>
              <label className="eko-toggle">
                <span>Human approval</span>
                <input
                  type="checkbox"
                  checked={approval}
                  onChange={(e) => setApproval(e.target.checked)}
                />
                <span aria-hidden="true" className="eko-switch" />
              </label>
              <div className="eko-policy-result" aria-live="polite">
                <span className="eko-mono">
                  {requested > cap
                    ? "REVIEW REQUIRED"
                    : "WITHIN POSITION LIMIT"}
                </span>
                <p>
                  {requested > cap
                    ? `The sample position exceeds your ${cap}% limit.`
                    : `The sample position is within your ${cap}% limit.`}{" "}
                  {approval
                    ? "An approval step is selected."
                    : "No approval step is selected."}
                </p>
              </div>
            </div>
            <a className="eko-button eko-button-light" href="#loop-lab">
              See the workflow {arrow}
            </a>
          </div>
        </article>
      </div>
      <p className="eko-note">
        External-agent preflight checks are advisory. Enforcement depends on the
        connected execution setup. This example does not change an agent or
        account.
      </p>
    </section>
  );
}
const replaySteps = [
  {
    name: "Define",
    text: "Make the assumptions explicit.",
    sub: "Entry rules · Exit rules · Cost model",
  },
  {
    name: "Replay",
    text: "Follow the rules through history.",
    sub: "Historical conditions · Point-in-time inputs",
  },
  {
    name: "Inspect",
    text: "See what shaped the result.",
    sub: "Entries · Exits · Simulated costs",
  },
];
export function LoopLab() {
  const [step, setStep] = useState(0);
  return (
    <section id="loop-lab" className="eko-section eko-frame">
      <Heading
        number="03"
        name="Loop Lab"
        title={["Test the rules.", "See the trade-offs."]}
        description="Turn a strategy into explicit rules. Replay historical conditions with entries, exits and simulated costs visible at each step."
        planned
      />
      <div className="eko-replay">
        <div className="eko-data-top">
          <span>LOOP LAB / STRATEGY REPLAY</span>
          <span>ILLUSTRATION / NO PERFORMANCE DATA</span>
        </div>
        <SignalField mode="terrain" intensity={0.65 + step * 0.15} />
        <div className="eko-replay-label">
          <span className="eko-mono">
            0{step + 1} / {replaySteps[step].name.toUpperCase()}
          </span>
          <h3>{replaySteps[step].text}</h3>
          <p>{replaySteps[step].sub}</p>
        </div>
        <div className="eko-replay-steps" aria-label="Explore replay stages">
          {replaySteps.map((s, i) => (
            <button
              key={s.name}
              onClick={() => setStep(i)}
              aria-pressed={step === i}
            >
              <span>0{i + 1}</span>
              {s.name}
              <i />
            </button>
          ))}
        </div>
      </div>
      <p className="eko-note">
        Historical results describe the past; they do not predict future
        performance.
      </p>
    </section>
  );
}
const journal = [
  {
    name: "Context",
    code: "READING",
    body: "The market context and reasons available at the time of the decision.",
    lines: [
      "Wallet activity reviewed",
      "Liquidity context recorded",
      "Reading freshness retained",
    ],
  },
  {
    name: "Preflight",
    code: "POLICY",
    body: "The requested action, the policy it was checked against, and the explanation.",
    lines: [
      "Position limit checked",
      "Asset policy referenced",
      "Approval state recorded",
    ],
  },
  {
    name: "Decision",
    code: "INTENT",
    body: "The decision and its stated rationale, kept alongside the preceding checks.",
    lines: [
      "Action intent recorded",
      "Rationale attached",
      "Decision time retained",
    ],
  },
  {
    name: "Reported outcome",
    code: "JOURNAL",
    body: "The outcome reported by the agent, with its origin and limits visible.",
    lines: [
      "Reported result attached",
      "Source distinguished",
      "Completeness not assumed",
    ],
  },
];
export function FlightRecorder() {
  const [active, setActive] = useState(0);
  return (
    <section id="flight-recorder" className="eko-section eko-frame">
      <Heading
        number="04"
        name="Flight Recorder"
        title={["A decision should", "leave a trail."]}
        description="Keep the context, policy check, decision and reported outcome together in a private decision journal."
        planned
      />
      <div className="eko-journal">
        <div className="eko-journal-track">
          {journal.map((item, i) => (
            <button
              key={item.code}
              onClick={() => setActive(i)}
              aria-pressed={active === i}
            >
              <span className="eko-journal-node">
                {active === i ? "●" : "+"}
              </span>
              <span className="eko-mono">
                0{i + 1} / {item.code}
              </span>
              <h3>{item.name}</h3>
            </button>
          ))}
        </div>
        <div className="eko-journal-detail" aria-live="polite">
          <div>
            <span className="eko-mono">SAMPLE JOURNAL / 0{active + 1}</span>
            <h3>{journal[active].name}</h3>
            <p>{journal[active].body}</p>
          </div>
          <ul>
            {journal[active].lines.map((line) => (
              <li key={line}>
                <span>↳</span>
                {line}
              </li>
            ))}
          </ul>
          <span className="eko-private">◇ PRIVATE BY DESIGN</span>
        </div>
      </div>
      <p className="eko-note">
        Private journals and public verdict receipts have separate visibility.
        Agent-reported outcomes may be incomplete.
      </p>
    </section>
  );
}
const controls = [
  [
    "Agents",
    "Know what is running.",
    "Identity, activity and connection state.",
  ],
  [
    "Exposure",
    "See where risk sits.",
    "Positions and the context around them.",
  ],
  [
    "Policy checks",
    "Understand what passed.",
    "Keep the reasons behind each check.",
  ],
  [
    "Approvals",
    "Keep decisions visible.",
    "Review requests that need your attention.",
  ],
  [
    "Activity",
    "Follow the decision trail.",
    "Context, action and reported outcome.",
  ],
  [
    "Control",
    "Know the boundary.",
    "Advisory and enforced states stay distinct.",
  ],
];
export function MissionControl() {
  return (
    <section id="mission-control" className="eko-section eko-frame">
      <Heading
        number="05"
        name="Mission Control"
        title={["One view.", "Every agent."]}
        description="Bring agents, exposure, policy checks and approvals into one workspace, with each state clearly explained."
        planned
      />
      <div className="eko-control-grid">
        <div className="eko-control-art">
          <SignalField mode="orbit" />
          <div className="eko-control-core">
            <img src={ekoMark} alt="" />
            <span>EKO</span>
          </div>
          <span className="eko-mono">
            INDEPENDENT MINDS / CONNECTED INTELLIGENCE
          </span>
        </div>
        {controls.map(([name, heading, body], index) => (
          <article key={name}>
            <span className="eko-mono">
              0{index + 1} / {name.toUpperCase()}
            </span>
            <h3>{heading}</h3>
            <p>{body}</p>
            <span className="eko-corner" aria-hidden="true">
              +
            </span>
          </article>
        ))}
      </div>
      <div className="eko-section-tail">
        <p>From individual actions to a connected picture.</p>
        <a href="/radar" className="eko-text-link">
          Open EKO {arrow}
        </a>
      </div>
    </section>
  );
}
export function Footer() {
  return (
    <footer className="eko-footer eko-frame">
      <div className="eko-footer-main">
        <div className="eko-footer-brand">
          <a href="#top" className="eko-brand eko-lockup" aria-label="EKO, back to top">
            <img src={ekoMark} alt="" />
            <span className="eko-brand-text">EKO</span>
          </a>
          <p>
            Independent minds.
            <br />
            Connected intelligence.
          </p>
          <span className="eko-mono">
            FOLLOW THE EVIDENCE BEHIND THE SIGNAL.
          </span>
        </div>
        <div>
          <h2>Discover</h2>
          <a href="#discover">The signal story</a>
          <a href="#senses">Senses</a>
          <a href="/radar">Terminal ↗</a>
          <a href="/pairs">New pairs ↗</a>
        </div>
        <div>
          <h2>The harness</h2>
          <a href="#harness">Guardrails</a>
          <a href="#loop-lab">Loop Lab</a>
          <a href="#flight-recorder">Flight Recorder</a>
          <a href="#roadmap">Roadmap</a>
          <a href="#mission-control">Mission Control</a>
        </div>
        <div>
          <h2>Explore</h2>
          <a href="/site/docs.html">Documentation</a>
          <a href="#faq">FAQ</a>
          <a href="/feed">Signal feed ↗</a>
          <a href="/legal/terms">Terms</a>
          <a href="/legal/privacy">Privacy</a>
          <a href="#top">Back to top ↑</a>
        </div>
      </div>
      <div className="eko-footer-bottom">
        <span>© 2026 EKO</span>
        <p>DYOR · Not financial advice · AI-generated analysis</p>
        <a href="#top" aria-label="Back to top">
          ↑
        </a>
      </div>
      <p className="eko-nonaffiliation">
        Built on Elysium · Not affiliated with, endorsed by, or
        officially connected with Kinetiq or Hyperliquid.
      </p>
    </footer>
  );
}
