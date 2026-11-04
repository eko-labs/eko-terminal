import { useEffect, useRef, useState } from "react";
import { motion, useInView, useReducedMotion } from "framer-motion";
import { radarProfiles, Sparkline, Verdict } from "./EkoDashboard";
import SignalCells from "./SignalCells";
import ekoMark from "../assets/eko-mark.svg";
import "./signal-grid.css";

const WIDTH = 1545,
  HEIGHT = 922;
const columns = [
  0, 117, 243, 369, 495, 622, 748, 873, 1000, 1126, 1252, 1378, 1545,
];
const rows = [0, 114.5, 229, 343.5, 458, 572.5, 687, 801.5, 922];
const blocked = [{ x: 510, y: 220, w: 510, h: 450 }];
const annotations = [
  ["WALLET", 218, 103],
  ["FLOW", 733, 103],
  ["LIQUIDITY", 1100, 103],
  ["EKO", 1495, 103],
  ["CONTEXT", 353, 217],
  ["RISK", 988, 217],
  ["SENSES", 1362, 217],
  ["EXIT COST", 344, 561],
  ["TRACE", 102, 677],
  ["GUARD", 1235, 677],
  ["SIGNAL", 723, 790],
  ["EVIDENCE", 1111, 790],
] as const;
const choices = ["GHOST", "ORBIT", "FROG"].map(
  (symbol) => radarProfiles.find((p) => p.symbol === symbol)!,
);

function Inspector() {
  const [symbol, setSymbol] = useState("GHOST");
  const coin = choices.find((p) => p.symbol === symbol)!;
  return (
    <div className="sg-inspector">
      <h2>Follow the evidence.</h2>
      <div className="sg-reading">
        <div className="sg-reading-label">
          <span>01 / MARKET READING</span>
          <span>SAMPLE</span>
        </div>
        <div className="sg-token">
          <label>
            <span className="sr-only">Inspect a sample token</span>
            <select
              aria-label="Inspect a sample token"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
            >
              {choices.map((p) => (
                <option key={p.symbol} value={p.symbol}>
                  ${p.symbol}
                </option>
              ))}
            </select>
            <small>{coin.name}</small>
          </label>
          <div>
            <Sparkline values={coin.series} />
            <span>
              {coin.change1h > 0 ? "+" : ""}
              {coin.change1h}% <small>/ 1H</small>
            </span>
          </div>
        </div>
      </div>
      <div className="sg-echo-mark" aria-hidden="true">
        <img src={ekoMark} alt="" />
      </div>
      <div className="sg-verdict" aria-live="polite">
        <div className="sg-verdict-top">
          <div>
            <small>02 / SIGNAL CONTEXT</small>
            <strong>
              {coin.composite}
              <span>/100</span>
            </strong>
          </div>
          <Verdict value={coin.verdict} />
        </div>
        <p>{coin.summary}</p>
        <div className="sg-metrics">
          <span>
            AGENT FLOW{" "}
            <b>
              {Math.round((coin.flow.agent + coin.flow.likely) * 100)}%{" "}
              <small>Beta</small>
            </b>
          </span>
          <span>
            EXIT AT $1K{" "}
            <b>
              {coin.exit["1000"] === null ? "Blocked" : `${coin.exit["1000"]}%`}
            </b>
          </span>
        </div>
      </div>
      <a className="sg-open" href={`/coin/${coin.address}`}>
        Open the evidence <span>↗</span>
      </a>
      <p className="sg-note">
        Sample snapshot · A signal is context, not certainty.
      </p>
    </div>
  );
}

/** Reference grid composition (00:17–00:28) with an EKO evidence inspector.
 * The local field video is new EKO artwork, not the unavailable DISCOVER source. */
export default function SignalGrid() {
  const frame = useRef<HTMLElement>(null),
    video = useRef<HTMLVideoElement>(null);
  const [scale, setScale] = useState(1),
    [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();
  const inView = useInView(frame, { amount: 0.15 });
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const resize = new ResizeObserver(([entry]) =>
      setScale(entry.contentRect.width / WIDTH),
    );
    resize.observe(el);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (inView && !paused && !reduced) void el.play().catch(() => {});
    else el.pause();
  }, [inView, paused, reduced]);
  return (
    <section
      id="discover"
      ref={frame}
      className="signal-grid"
      aria-label="Explore how an EKO signal forms"
    >
      <div
        className="sg-scene"
        style={{ width: WIDTH, height: HEIGHT, transform: `scale(${scale})` }}
      >
        <div className="sg-video-field" aria-hidden="true">
          <video
            ref={video}
            muted
            loop
            playsInline
            preload="metadata"
            poster={`${import.meta.env.BASE_URL}media/eko-signal-field.webp`}
            src={`${import.meta.env.BASE_URL}media/eko-signal-field.mp4`}
          />
          <div className="sg-video-vignette" />
        </div>
        <div className="sg-grid-art" aria-hidden="true">
          {!reduced && !paused && (
            <SignalCells
              colEdges={columns}
              rowEdges={rows}
              width={WIDTH}
              height={HEIGHT}
              blocked={blocked}
            />
          )}
          {columns.slice(1, -1).map((x, i) => (
            <motion.i
              key={x}
              className="sg-vline"
              style={{ left: x }}
              initial={{ scaleY: 0 }}
              whileInView={{ scaleY: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: i * 0.04 }}
            />
          ))}
          {rows.map((y, i) => (
            <motion.i
              key={y}
              className="sg-hline"
              style={{ top: y }}
              initial={{ scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, delay: i * 0.04 }}
            />
          ))}
          {annotations.map(([label, x, y]) => (
            <span
              className="sg-annotation"
              key={`${label}-${x}`}
              style={{ left: x, top: y }}
            >
              {label}
            </span>
          ))}
          {[
            { x: 370, y: 1 },
            { x: 1127, y: 230 },
            { x: 244, y: 688 },
            { x: 1379, y: 803 },
          ].map((p, i) => (
            <div
              className="sg-symbol-tile"
              style={{ left: p.x, top: p.y, transform: `rotate(${i * 90}deg)` }}
              key={i}
            >
              <img src={ekoMark} alt="" />
            </div>
          ))}
        </div>
        <div className="sg-side-label sg-left" aria-hidden="true">
          <span>→</span> ACTIVITY
        </div>
        <div className="sg-side-label sg-right" aria-hidden="true">
          SIGNAL <span>←</span>
        </div>
        <div className="sg-center">
          <Inspector />
        </div>
      </div>
      <div className="sg-mobile">
        <Inspector />
      </div>
      <div className="sg-foot">
        <span>EKO / SIGNAL DISCOVERY</span>
        <button
          type="button"
          aria-pressed={paused || !!reduced}
          onClick={() => setPaused((p) => !p)}
          disabled={!!reduced}
        >
          {paused || reduced ? "Ⅱ Motion paused" : "Ⅱ Pause motion"}
        </button>
      </div>
    </section>
  );
}
