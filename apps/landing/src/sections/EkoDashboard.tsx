import { motion } from "framer-motion";
import profiles from "../../../web/src/mocks/demo/radar-profiles.json";
import ekoMark from "../assets/eko-mark.svg";
import "./eko-dashboard.css";

export const radarProfiles = profiles;
export type RadarProfile = (typeof profiles)[number];
export function Sparkline({
  values,
  className = "",
}: {
  values: number[];
  className?: string;
}) {
  const min = Math.min(...values),
    range = Math.max(...values) - min || 1;
  const points = values
    .map(
      (v, i) =>
        `${(i * 300) / (values.length - 1)},${57 - ((v - min) / range) * 48}`,
    )
    .join(" ");
  return (
    <svg
      className={`eko-spark ${className}`}
      viewBox="0 0 300 64"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
export function Verdict({ value }: { value: string }) {
  return (
    <span className={`ed-verdict ed-${value}`}>
      {value === "clear" ? "✓" : value === "danger" ? "⊗" : "△"}{" "}
      {value === "clear" ? "No flags" : value[0].toUpperCase() + value.slice(1)}
    </span>
  );
}
const sections = [
  {
    title: "01 / TERMINAL",
    links: [
      ["◎", "Radar", "/radar"],
      ["◫", "New pairs", "/pairs"],
      ["☷", "Feed", "/feed"],
      ["♧", "Bags", "/bags"],
      ["⊙", "Watchlist", "/watch"],
    ],
  },
  {
    title: "02 / MISSION CONTROL",
    links: [
      ["◧", "Overview", "/mission"],
      ["♧", "Connect an agent", "/mission/connect"],
    ],
  },
  {
    title: "03 / PUBLIC RECORD",
    links: [
      ["▥", "Scoreboard", "/scoreboard"],
      ["⊹", "Census", "/census"],
    ],
  },
];
const hot = ["YOLK", "GHOST", "ORBIT"].map(
  (symbol) => profiles.find((p) => p.symbol === symbol)!,
);
const percent = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
function Bars({ warm = false }: { warm?: boolean }) {
  return (
    <span className={`ed-bars ${warm ? "warm" : ""}`} aria-hidden="true">
      {Array.from({ length: 24 }, (_, i) => (
        <i
          key={i}
          style={{ height: 3 + (Math.sin(i * 1.4) + 1) * 7 + (i % 4) }}
        />
      ))}
    </span>
  );
}

/** A scoped presentation of the imported Radar, using its exact frozen demo profiles.
 * Links open the original application; this component never connects a wallet or executes a trade. */
export default function EkoDashboard({
  x,
  y,
  width,
  height,
  scale = 1,
  radius = 7.11,
  zIndex,
  revealDelay = 0,
  className = "",
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  scale?: number;
  radius?: number;
  zIndex?: number;
  revealDelay?: number;
  className?: string;
}) {
  const rows = profiles;
  return (
    <motion.div
      className={`absolute overflow-hidden ${className}`}
      style={{
        left: x,
        top: y,
        width,
        height,
        borderRadius: radius,
        background: "#000",
        zIndex,
      }}
      initial={{ y: 40, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.7, delay: revealDelay }}
    >
      <section
        className="eko-dashboard"
        aria-hidden="true"
        inert
        style={{ transform: `scale(${scale})` }}
      >
        <div className="ed-top">
          <a href="/radar" className="eko-brand ed-brand">
            <img src={ekoMark} alt="" /><span className="eko-brand-text">EKO</span>
          </a>
          <span>
            TERMINAL <i>/</i> RADAR
          </span>
          <small>
            <b>●</b> SAMPLE DATA <i>|</i> BLOCK 4,663,000
          </small>
        </div>
        <aside className="ed-side">
          <a className="ed-search" href="/radar">
            Search or paste a CA <span>↗ /</span>
          </a>
          {sections.map((group) => (
            <div className="ed-navgroup" key={group.title}>
              <small>{group.title}</small>
              {group.links.map(([icon, label, href]) => (
                <a
                  key={label}
                  href={href}
                  className={label === "Radar" ? "on" : ""}
                >
                  <span>{icon}</span>
                  {label}
                </a>
              ))}
            </div>
          ))}
          <div className="ed-side-bottom">
            <a href="/settings/plan">Listener</a>
            <small>Risk mode</small>
            <div className="ed-risk">
              Careful <b>Balanced</b> Degen
            </div>
            <a href="/radar" className="ed-wallet">
              Open terminal ↗
            </a>
            <small>Built on Elysium</small>
          </div>
        </aside>
        <div className="ed-content">
          <div className="ed-pagehead">
            <div>
              <h3>Radar</h3>
              <p>
                Every live play on Elysium, scanned by the guard, most
                traded first.
              </p>
            </div>
            <dl>
              {[
                ["1,204", "Scanned today"],
                ["37", "Honeypots refused"],
                [
                  String(profiles.filter((p) => p.verdict === "danger").length),
                  "Danger now",
                ],
              ].map(([value, label], i) => (
                <div key={label}>
                  <dd>{value}</dd>
                  <Bars warm={i > 0} />
                  <dt>{label}</dt>
                </div>
              ))}
            </dl>
          </div>
          <a
            href={`/coin/${profiles.find((p) => p.symbol === "EKOX")!.address}`}
            className="ed-alert"
          >
            <span>
              △ <b>Ghost Report</b> · $EKOX copies $EKO and routes through a 79%
              fee-trap pool.
            </span>
            <span>See the evidence ↗</span>
          </a>
          <div className="ed-section-title">
            <span>01 / HOT RIGHT NOW</span>
            <small>
              Unusual activity and agent buying. Not a recommendation.
            </small>
            <i />
          </div>
          <div className="ed-hot">
            {hot.map((p) => (
              <a
                href={`/coin/${p.address}`}
                className="ed-hotcard"
                key={p.symbol}
              >
                <div className="ed-hotname">
                  <strong>${p.symbol}</strong>
                  <Verdict value={p.verdict} />
                </div>
                <Sparkline values={p.series} />
                <div className="ed-hotstats">
                  <span>
                    <small>
                      SIGNAL <em>Beta</em>
                    </small>
                    {p.composite}
                    <em>/100</em>
                  </span>
                  <span>
                    <small>AGENTS</small>
                    {Math.round((p.flow.agent + p.flow.likely) * 100)}%
                  </span>
                  <span>
                    <small>1H</small>
                    {percent(p.change1h)}
                  </span>
                </div>
              </a>
            ))}
          </div>
          <div className="ed-section-title ed-table-title">
            <span>02 / ALL COINS</span>
            <small>
              {rows.length} of {profiles.length}
            </small>
            <i />
            <small>● Sample snapshot</small>
          </div>
          <div className="ed-filters">
            {["All", "No flags", "Monitor", "Danger"].map((f) => (
              <span key={f} className={`ed-filter ${f === "All" ? "on" : ""}`}>
                {f}
              </span>
            ))}
            <span>
              All stages <span>⌄</span>
            </span>
            <span>Sort: Rank</span>
          </div>
          <table className="ed-table">
            <thead>
              <tr>
                {[
                  "Coin",
                  "Guard",
                  "Watch for",
                  "Signal",
                  "1h",
                  "Last 8h",
                  "Who’s buying",
                  "Exit at $1k",
                ].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((p) => (
                <tr key={p.address}>
                  <td>
                    <a href={`/coin/${p.address}`}>
                      <b>${p.symbol}</b>
                      <small>{p.name}</small>
                    </a>
                  </td>
                  <td>
                    <Verdict value={p.verdict} />
                  </td>
                  <td>
                    {p.matches[0]?.id.replaceAll("_", " ") || "Nothing matched"}
                  </td>
                  <td>{p.composite}</td>
                  <td className={p.change1h < 0 ? "down" : ""}>
                    {percent(p.change1h)}
                  </td>
                  <td>
                    <Sparkline values={p.series} />
                  </td>
                  <td>
                    <span className="ed-flow">
                      <i
                        style={{
                          width: `${(p.flow.agent + p.flow.likely) * 100}%`,
                        }}
                      />
                    </span>
                    {Math.round((p.flow.agent + p.flow.likely) * 100)}%{" "}
                    <small>Beta</small>
                  </td>
                  <td>
                    {p.exit["1000"] === null ? "Blocked" : `${p.exit["1000"]}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </motion.div>
  );
}
