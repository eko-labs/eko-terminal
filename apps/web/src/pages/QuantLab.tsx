import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  DEFAULT_ASSUMPTIONS,
  TIMEFRAMES,
  TIMEFRAME_SECONDS,
  formatDuration,
    formatPct,
  formatPrice,
  formatQty,
  formatUsd,
  getMarket,
  positionSize,
  riskReward,
  type BacktestAssumptions,
  type BacktestResult,
  type BacktestTrade,
  type ParamSpec,
  type ParamValue,
  type Params,
  type SegmentMetrics,
  type Timeframe,
} from '@eko/shared';
import { api } from '../lib/api';
import { useMedia } from '../lib/useMedia';
import { useApp } from '../store/app';
import { EquityChart } from '../components/lab/EquityChart';
import { Kv, Panel, Sub, Switch, TableWrap, fmtDate, fmtDay, fmtSpan, fmtTime, readLocal, toneOf, writeLocal } from '../components/lab/ui';
import { IconAlert, IconChevron, IconInfo } from '../components/icons';

// ═════════════════════════ Types ═════════════════════════

type BtResult = BacktestResult & { dataSource: string; simulatedData: boolean };

interface BtRequest {
  strategyId: string;
  params: Params;
  market: string;
  timeframe: Timeframe;
  bars: number;
  assumptions: BacktestAssumptions;
}

interface BtResponse {
  result: BtResult;
  methodology: string;
}

interface BtRun extends BtResponse {
  request: BtRequest;
  ranAt: number;
}

type Tab = 'backtest' | 'risk';
const TABS: { id: Tab; label: string }[] = [
  { id: 'backtest', label: 'Backtester' },
  { id: 'risk', label: 'Position & risk' },
];
const TAB_IDS = TABS.map((t) => t.id);
const LS_TAB = 'eko.lab.tab';

// ═════════════════════════ Page ═════════════════════════

export function QuantLab() {
  const config = useApp((s) => s.config);
  const [tab, setTab] = useState<Tab>(() => readLocal(LS_TAB, TAB_IDS, 'backtest'));
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const choose = (t: Tab) => {
    setTab(t);
    writeLocal(LS_TAB, t);
  };
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TAB_IDS.indexOf(tab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % TAB_IDS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + TAB_IDS.length) % TAB_IDS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TAB_IDS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TAB_IDS[next]!;
    choose(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <div className="page">
      <div className="page-inner ql">
        <header className="page-head">
          <div>
            <h1 className="page-title">Rule Lab</h1>
            <p className="page-sub">Test rules on past candles and size a position. Every number shows its sample, period and assumptions.</p>
          </div>
        </header>

        <div className="lx-tabbar" role="tablist" aria-label="Rule Lab tools" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              id={`ql-tab-${t.id}`}
              role="tab"
              className="tab"
              aria-selected={tab === t.id}
              aria-controls={`ql-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => choose(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`ql-panel-${tab}`} aria-labelledby={`ql-tab-${tab}`} className="ql-tabpanel">
          {!config ? <div className="skel" style={{ height: 320 }} /> : tab === 'backtest' ? <Backtester /> : <RiskTools />}
        </div>

      </div>
    </div>
  );
}

// ═════════════════════════ Backtester ═════════════════════════

const defaultsOf = (specs: ParamSpec[]): Params => Object.fromEntries(specs.map((s) => [s.key, s.default]));

function paramError(s: ParamSpec, v: ParamValue | undefined): string | null {
  if (s.type === 'bool') return typeof v === 'boolean' ? null : 'Required';
  if (s.type === 'enum') return typeof v === 'string' && (!s.options || s.options.includes(v)) ? null : 'Choose an option';
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'Enter a number';
  if (s.type === 'int' && !Number.isInteger(v)) return 'Whole number';
  if (s.min !== undefined && v < s.min) return `Min ${s.min}`;
  if (s.max !== undefined && v > s.max) return `Max ${s.max}`;
  return null;
}

/** Mirrors the server's validation for /api/backtests assumptions. */
function assumptionErrors(a: BacktestAssumptions): Partial<Record<keyof BacktestAssumptions, string>> {
  const e: Partial<Record<keyof BacktestAssumptions, string>> = {};
  const rng = (k: keyof BacktestAssumptions, v: number, lo: number, hi: number, msg: string) => {
    if (!Number.isFinite(v) || v < lo || v > hi) e[k] = msg;
  };
  rng('feeBps', a.feeBps, 0, 200, '0–200 bps');
  rng('slippageBps', a.slippageBps, 0, 200, '0–200 bps');
  rng('allocation', a.allocation, 0.01, 1, '1–100%');
  rng('maxHoldBars', a.maxHoldBars, 0, 500, '0–500 bars');
  if (!e.maxHoldBars && !Number.isInteger(a.maxHoldBars)) e.maxHoldBars = 'Whole number';
  rng('inSampleFraction', a.inSampleFraction, 0.1, 0.95, '10–95%');
  rng('startingEquity', a.startingEquity, 1, 1e9, 'Up to $1,000,000,000');
  return e;
}

const EXIT_LABEL: Record<BacktestTrade['exitReason'], string> = {
  signal: 'Sell signal',
  stop: 'Stop',
  max_hold: 'Max hold',
  end_of_data: 'End of data',
};

function Backtester() {
  const config = useApp((s) => s.config)!;
  const layoutMarket = useApp((s) => s.layout.market);
  const rules = config.strategies.rules;
  const [strategyId, setStrategyId] = useState(rules[0]?.id ?? '');
  const [params, setParams] = useState<Params>(() => defaultsOf(rules[0]?.params ?? []));
  const [market, setMarket] = useState(config.markets.some((m) => m.id === layoutMarket) ? layoutMarket : (config.markets[0]?.id ?? 'ETH-USD'));
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');
  const [bars, setBars] = useState(1000);
  const [assm, setAssm] = useState<BacktestAssumptions>({ ...DEFAULT_ASSUMPTIONS });
  const [running, setRunning] = useState<null | 'run'>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<BtRun | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const strategy = rules.find((r) => r.id === strategyId) ?? null;
  const specs: ParamSpec[] = strategy?.params ?? [];
  const marketOptions = config.markets;
  const chooseStrategy = (id: string) => {
    setStrategyId(id);
    setParams(defaultsOf(rules.find((r) => r.id === id)?.params ?? []));
  };
  const resetParams = () => chooseStrategy(strategyId);

  const pErrors = Object.fromEntries(specs.map((s) => [s.key, paramError(s, params[s.key])]).filter(([, v]) => v)) as Record<string, string>;
  const aErrors = assumptionErrors(assm);
  const barsError = !Number.isInteger(bars) || bars < 100 || bars > 5000 ? '100–5,000 bars' : null;
  const invalid = !!barsError || Object.keys(pErrors).length > 0 || Object.keys(aErrors).length > 0 || !strategyId;

  const request: BtRequest = { strategyId: strategyId, params, market, timeframe, bars, assumptions: assm };
  const stale = !!run && JSON.stringify(run.request) !== JSON.stringify(request);

  const execute = async (req: BtRequest) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning('run');
    setError(null);
    try {
      const r = await api<BtResponse>('/api/backtests', { body: req, signal: ac.signal });
      setRun({ ...r, request: req, ranAt: Date.now() });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError((e as Error).message);
    } finally {
      if (abortRef.current === ac) setRunning(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!invalid && !running) void execute(request);
  };

  const span = TIMEFRAME_SECONDS[timeframe] * (Number.isFinite(bars) ? bars : 0) * 1000;

  return (
    <div className="ql-bt">
      <div className="ql-bt-grid">
        <form className="panel ql-config" onSubmit={onSubmit} aria-label="Backtest configuration" noValidate>
          <fieldset className="ql-group">
            <legend className="ql-legend">
              <span className="ql-step num">01</span> Strategy
            </legend>
            <label className="field">
              Strategy
              <select className="input" value={strategyId} onChange={(e) => chooseStrategy(e.target.value)}>
                {rules.map((r) => <option key={r.id} value={r.id}>{r.name} · v{r.version}</option>)}
              </select>
            </label>
            {strategy ? (
              <p className="ql-desc">
                {strategy.summary}
              </p>
            ) : null}
          </fieldset>

          <fieldset className="ql-group">
            <legend className="ql-legend">
              <span className="ql-step num">02</span> Data
            </legend>
            <label className="field">
              Market
              <select className="input" value={market} onChange={(e) => setMarket(e.target.value)}>
                {marketOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id} · {m.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="field" role="group" aria-labelledby="ql-tf-label">
              <span id="ql-tf-label">Timeframe</span>
              <div className="seg ql-seg-full tf-seg">
                {TIMEFRAMES.map((tf) => (
                  <button type="button" key={tf} aria-pressed={timeframe === tf} onClick={() => setTimeframe(tf)}>
                    {tf}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span className="ql-field-row">
                Bars <span className="num muted">{span > 0 ? `≈ ${formatDuration(span)} of history` : ''}</span>
              </span>
              <input
                className="input num"
                type="number"
                min={100}
                max={5000}
                step={100}
                value={Number.isFinite(bars) ? bars : ''}
                onChange={(e) => setBars(e.target.valueAsNumber)}
                aria-invalid={!!barsError}
                aria-describedby={barsError ? 'ql-bars-err' : undefined}
              />
              {barsError ? (
                <span className="lx-err" id="ql-bars-err">
                  {barsError}
                </span>
              ) : null}
            </label>
            <div className="ql-presets" role="group" aria-label="Bar count presets">
              {[500, 1000, 2000, 5000].map((n) => (
                <button type="button" key={n} className="chip num" aria-pressed={bars === n} onClick={() => setBars(n)}>
                  {n.toLocaleString()}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="ql-group">
            <legend className="ql-legend">
              <span className="ql-step num">03</span> Parameters
              <span className="grow" />
              <button type="button" className="btn sm ghost" onClick={resetParams}>
                Defaults
              </button>
            </legend>
            {specs.length ? (
              <div className="ql-fields">
                {specs.map((s) => (
                  <ParamField key={s.key} spec={s} value={params[s.key]} error={pErrors[s.key] ?? null} onChange={(v) => setParams((p) => ({ ...p, [s.key]: v }))} />
                ))}
              </div>
            ) : (
              <p className="ql-desc muted">This strategy has no parameters.</p>
            )}
          </fieldset>

          <fieldset className="ql-group">
            <legend className="ql-legend">
              <span className="ql-step num">04</span> Assumptions
              <span className="grow" />
              <button type="button" className="btn sm ghost" onClick={() => setAssm({ ...DEFAULT_ASSUMPTIONS })}>
                Defaults
              </button>
            </legend>
            <div className="ql-fields">
              <NumField label="Fee" unit="bps / side" value={assm.feeBps} step={1} min={0} max={200} error={aErrors.feeBps} onChange={(v) => setAssm({ ...assm, feeBps: v })} />
              <NumField label="Slippage" unit="bps / side" value={assm.slippageBps} step={1} min={0} max={200} error={aErrors.slippageBps} onChange={(v) => setAssm({ ...assm, slippageBps: v })} />
              <NumField
                label="Allocation"
                unit="% equity"
                value={round(assm.allocation * 100, 4)}
                step={5}
                min={1}
                max={100}
                error={aErrors.allocation}
                onChange={(v) => setAssm({ ...assm, allocation: v / 100 })}
              />
              <NumField label="Max hold" unit="bars · 0 = off" value={assm.maxHoldBars} step={1} min={0} max={500} error={aErrors.maxHoldBars} onChange={(v) => setAssm({ ...assm, maxHoldBars: v })} />
              <NumField
                label="In-sample"
                unit="% of bars"
                value={round(assm.inSampleFraction * 100, 4)}
                step={5}
                min={10}
                max={95}
                error={aErrors.inSampleFraction}
                onChange={(v) => setAssm({ ...assm, inSampleFraction: v / 100 })}
              />
              <NumField label="Starting equity" unit="USD" value={assm.startingEquity} step={1000} min={1} max={1e9} error={aErrors.startingEquity} onChange={(v) => setAssm({ ...assm, startingEquity: v })} />
            </div>
            <Switch
              checked={assm.useInvalidationStop}
              onChange={(v) => setAssm({ ...assm, useInvalidationStop: v })}
              label="Exit at the signal’s invalidation level"
              hint="Gap-aware: fills at the worse of the bar open and the stop."
            />
          </fieldset>

          <div className="ql-run">
            <button type="submit" className="btn lg primary ql-run-btn" disabled={invalid || !!running} aria-busy={running === 'run'}>
              {running === 'run' ? <span className="spinner" aria-hidden /> : null}
              {running === 'run' ? 'Running backtest…' : run ? 'Run again' : 'Run backtest'}
            </button>
            {invalid ? <span className="lx-err">Fix the highlighted fields to run.</span> : <span className="ql-run-hint">Runs server-side on {getMarket(market)?.name ?? market} candles from the configured data source.</span>}
          </div>
        </form>

        <div className="ql-results" aria-live="polite" aria-busy={!!running}>
          {error ? (
            <div className="callout warn" role="alert">
              <IconAlert size={14} />
              <div>
                <strong className="ql-strong">Backtest failed.</strong> {error}
              </div>
            </div>
          ) : null}
          {run ? (
            <BacktestResults run={run} stale={stale} specs={rules.find((x) => x.id === run.result.strategyId)?.params ?? []} strategyName={rules.find((r) => r.id === run.result.strategyId)?.name ?? run.result.strategyId} />
          ) : running ? (
            <ResultsSkeleton />
          ) : (
            <HowItWorks inSample={assm.inSampleFraction} />
          )}
        </div>
      </div>
    </div>
  );
}

const round = (v: number, dp: number) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : v);

function NumField({ label, unit, value, onChange, error, step, min, max }: { label: string; unit?: string; value: number; onChange: (v: number) => void; error?: string | null; step?: number | 'any'; min?: number; max?: number }) {
  const id = useId();
  return (
    <label className="field ql-num" htmlFor={id}>
      <span className="ql-field-row">
        {label}
        {unit ? <span className="ql-unit">{unit}</span> : null}
      </span>
      <input
        id={id}
        className="input num"
        type="number"
        value={Number.isFinite(value) ? value : ''}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : undefined}
      />
      {error ? (
        <span className="lx-err" id={`${id}-err`}>
          {error}
        </span>
      ) : null}
    </label>
  );
}

function ParamField({ spec, value, onChange, error }: { spec: ParamSpec; value: ParamValue | undefined; onChange: (v: ParamValue) => void; error: string | null }) {
  const id = `ql-p-${spec.key}`;
  if (spec.type === 'bool')
    return (
      <div className="ql-num ql-num--wide">
        <Switch id={id} checked={value === true} onChange={onChange} label={spec.label} hint={spec.description} />
      </div>
    );
  if (spec.type === 'enum')
    return (
      <label className="field ql-num" htmlFor={id} title={spec.description}>
        <span className="ql-field-row">{spec.label}</span>
        <select id={id} className="input" value={String(value ?? spec.default)} onChange={(e) => onChange(e.target.value)}>
          {(spec.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  const range = spec.min !== undefined && spec.max !== undefined ? `${spec.min}–${spec.max}` : undefined;
  return (
    <label className="field ql-num" htmlFor={id} title={spec.description}>
      <span className="ql-field-row">
        {spec.label}
        {range ? <span className="ql-unit num">{range}</span> : null}
      </span>
      <input
        id={id}
        className="input num"
        type="number"
        min={spec.min}
        max={spec.max}
        step={spec.step ?? (spec.type === 'int' ? 1 : 'any')}
        value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        aria-invalid={!!error}
        aria-describedby={`${id}-d`}
      />
      <span className={error ? 'lx-err' : 'sr-only'} id={`${id}-d`}>
        {error ?? spec.description}
      </span>
    </label>
  );
}

function HowItWorks({ inSample }: { inSample: number }) {
  const n = 40;
  const split = Math.round(n * (Number.isFinite(inSample) ? Math.min(0.95, Math.max(0.1, inSample)) : 0.7));
  return (
    <div className="panel ql-how">
      <div className="ql-how-head">
        <span className="eyebrow">How the simulation works</span>
        <h2 className="ql-how-title">Point-in-time, long-only, costs included.</h2>
      </div>
      <figure className="ql-strip" aria-label={`Schematic: first ${Math.round((split / n) * 100)}% of bars are in-sample, the rest out-of-sample`}>
        <div className="ql-strip-bars" aria-hidden>
          {Array.from({ length: n }, (_, i) => (
            <span key={i} className={i < split ? 'is-in' : 'is-out'} />
          ))}
          <span className="ql-strip-split" style={{ left: `${(split / n) * 100}%` }} />
        </div>
        <figcaption className="ql-strip-cap">
          <span style={{ width: `${(split / n) * 100}%` }}>
            In-sample <b className="num">{Math.round((split / n) * 100)}%</b>
          </span>
          <span>
            Out-of-sample <b className="num">{100 - Math.round((split / n) * 100)}%</b>
          </span>
        </figcaption>
        <p className="ql-strip-note">Schematic — not market data.</p>
      </figure>
      <ol className="ql-steps">
        <li>
          <span className="ql-step num">1</span>
          <div>
            <strong>Signal at the close of bar i</strong>
            <p>The strategy only sees bars 0…i. No future data, no repainting.</p>
          </div>
        </li>
        <li>
          <span className="ql-step num">2</span>
          <div>
            <strong>Fill at the open of bar i+1</strong>
            <p>Adjusted by slippage against you. SELL closes a position — it never opens a short.</p>
          </div>
        </li>
        <li>
          <span className="ql-step num">3</span>
          <div>
            <strong>Fees on entry and exit</strong>
            <p>Charged in basis points of notional. Optional stop at the signal’s invalidation level.</p>
          </div>
        </li>
        <li>
          <span className="ql-step num">4</span>
          <div>
            <strong>Held-out segment reported separately</strong>
            <p>Parameters are not re-fit on the out-of-sample bars — that column is the more honest read.</p>
          </div>
        </li>
      </ol>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="ql-skel" aria-label="Running backtest">
      <div className="skel" style={{ height: 44, width: '60%' }} />
      <div className="skel" style={{ height: 72 }} />
      <div className="skel" style={{ height: 360 }} />
    </div>
  );
}

const pct1 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`);

function profitFactor(m: Pick<SegmentMetrics, 'profitFactor' | 'trades' | 'losses'>): { text: string; title?: string } {
  // JSON cannot carry Infinity: a null factor with trades but no losses means "no losing trades".
  if (m.profitFactor === null || m.profitFactor === undefined) return m.trades > 0 && m.losses === 0 ? { text: '∞', title: 'No losing trades in this segment' } : { text: '—' };
  if (!Number.isFinite(m.profitFactor)) return { text: '∞', title: 'No losing trades in this segment' };
  return { text: m.profitFactor.toFixed(2) };
}

function BacktestResults({
  run,
  stale,
  specs,
  strategyName,
}: {
  run: BtRun;
  stale: boolean;
  specs: ParamSpec[];
  strategyName: string;
}) {
  const r = run.result;
  const o = r.metrics.overall;
  const is = r.metrics.inSample;
  const oos = r.metrics.outOfSample;
  const a = r.assumptions;
  const [showTrades, setShowTrades] = useState(r.trades.length <= 120);
  const narrow = useMedia('(max-width: 640px)');
  const segEnd = r.period.end;
  const labelFor = (k: string) => specs.find((s) => s.key === k)?.label ?? k;

  return (
    <div className="ql-res">
      <header className="ql-res-head">
        <div className="ql-res-title">
          <div className="ql-res-badges">
            <span className="badge outline">Backtest</span>
            <span className="badge outline" title="Where the candles came from">
              {r.dataSource}
            </span>
            {r.simulatedData ? (
              <span className="badge warn" title="Candles come from the deterministic simulator, not a real exchange">
                Simulated data
              </span>
            ) : null}
          </div>
          <h2>
            {strategyName} <span className="muted num">v{r.strategyVersion}</span>
          </h2>
          <p className="ql-res-meta num">
            {run.request.market} · {run.request.timeframe} · {r.candles.toLocaleString()} bars ({r.warmupBars} warm-up) · {fmtDate(r.period.start)} → {fmtDate(r.period.end)} ({fmtSpan(r.period.start, r.period.end)})
          </p>
        </div>
        <div className="ql-res-actions">
          <span className="ql-ran num">Ran {new Date(run.ranAt).toLocaleTimeString(undefined, { hour12: false })}</span>
        </div>
      </header>

      {stale ? (
        <div className="callout ql-stale">
          <IconInfo size={14} />
          <span>Settings have changed since this run. The results below still reflect the previous configuration.</span>
        </div>
      ) : null}

      <section className="callout warn ql-limits" aria-label="Limitations">
        <IconAlert size={14} />
        <div>
          <strong className="ql-strong">Read before trusting these numbers</strong>
          <ul>
            {r.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
            {r.simulatedData ? <li>Candles are simulated; results say nothing about real markets.</li> : null}
          </ul>
        </div>
      </section>

      <div className="stat-row ql-hero">
        <div className="stat">
          <span className="stat-label">Total return</span>
          <span className={`stat-value ${toneOf(o.totalReturnPct)}`}>{formatPct(o.totalReturnPct)}</span>
          <span className="stat-foot num">Buy & hold {formatPct(o.buyHoldReturnPct)}</span>
        </div>
        <div className="stat ql-hero-oos">
          <span className="stat-label">Out-of-sample</span>
          <span className={`stat-value ${toneOf(oos.totalReturnPct)}`}>{formatPct(oos.totalReturnPct)}</span>
          <span className="stat-foot num">
            {oos.trades} trades · {oos.bars.toLocaleString()} bars held out
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Max drawdown</span>
          <span className={`stat-value ${o.maxDrawdownPct < 0 ? 'down' : ''}`}>{formatPct(o.maxDrawdownPct, 2, false)}</span>
          <span className="stat-foot">Peak to trough, marked at each close</span>
        </div>
        <div className="stat">
          <span className="stat-label">Winning trades</span>
          <span className="stat-value">{pct1(o.winRate)}</span>
          <span className="stat-foot num">
            {o.wins} of {o.trades} trades
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Expectancy</span>
          <span className={`stat-value ${toneOf(o.expectancyPct)}`}>{formatPct(o.expectancyPct)}</span>
          <span className="stat-foot">Mean per trade, after costs</span>
        </div>
        <div className="stat">
          <span className="stat-label">Profit factor</span>
          <span className="stat-value" title={profitFactor(o).title}>
            {profitFactor(o).text}
          </span>
          <span className="stat-foot num">Fees paid {formatUsd(o.feesPaid, 0)}</span>
        </div>
      </div>

      <Panel
        title="Equity & drawdown"
        note={<span className="num">Start {formatUsd(a.startingEquity, 0)} · split {fmtTime(r.period.splitTime)}</span>}
        actions={
          r.trades.length ? (
            <label className="lx-check">
              <input type="checkbox" checked={showTrades} onChange={(e) => setShowTrades(e.target.checked)} /> Trade markers
            </label>
          ) : null
        }
        className="ql-chart"
      >
        {r.equity.length ? (
          <EquityChart equity={r.equity} splitTime={r.period.splitTime || null} startingEquity={a.startingEquity} trades={r.trades} showTrades={showTrades} height={narrow ? 280 : 360} />
        ) : (
          <div className="empty">
            <strong>No equity data</strong>
          </div>
        )}
      </Panel>

      <div className="ql-two">
        <Panel title="Metrics by segment" note="Trades belong to the segment they were entered in" className="ql-metrics-panel">
          <TableWrap label="Backtest metrics by segment">
            <table className="table ql-metrics">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col" className="r">
                    Overall
                    <Sub>
                      {fmtDay(r.period.start)} → {fmtDay(segEnd)}
                    </Sub>
                  </th>
                  <th scope="col" className="r">
                    In-sample
                    <Sub>
                      {fmtDay(r.period.start)} → {fmtDay(r.period.splitTime)}
                    </Sub>
                  </th>
                  <th scope="col" className="r ql-oos-col">
                    Out-of-sample
                    <Sub>
                      {fmtDay(r.period.splitTime)} → {fmtDay(segEnd)}
                    </Sub>
                  </th>
                </tr>
              </thead>
              <tbody>
                <MetricRow label="Bars" m={[o, is, oos]} f={(m) => m.bars.toLocaleString()} />
                <MetricRow label="Trades (sample size)" m={[o, is, oos]} f={(m) => m.trades} sub={(m) => `${m.wins} W · ${m.losses} L`} />
                <MetricRow label="Winning trades" m={[o, is, oos]} f={(m) => pct1(m.winRate)} />
                <MetricRow label="Avg win" m={[o, is, oos]} f={(m) => formatPct(m.avgWinPct)} tone={(m) => toneOf(m.avgWinPct)} />
                <MetricRow label="Avg loss" m={[o, is, oos]} f={(m) => formatPct(m.avgLossPct)} tone={(m) => toneOf(m.avgLossPct)} />
                <MetricRow label="Expectancy / trade" m={[o, is, oos]} f={(m) => formatPct(m.expectancyPct)} tone={(m) => toneOf(m.expectancyPct)} />
                <MetricRow label="Profit factor" m={[o, is, oos]} f={(m) => profitFactor(m).text} />
                <MetricRow label="Total return" m={[o, is, oos]} f={(m) => formatPct(m.totalReturnPct)} tone={(m) => toneOf(m.totalReturnPct)} strong />
                <MetricRow label="Buy & hold return" m={[o, is, oos]} f={(m) => formatPct(m.buyHoldReturnPct)} tone={() => 'dim'} />
                <MetricRow label="Max drawdown" m={[o, is, oos]} f={(m) => formatPct(m.maxDrawdownPct, 2, false)} tone={(m) => (m.maxDrawdownPct < 0 ? 'down' : '')} />
                <MetricRow label="Exposure" m={[o, is, oos]} f={(m) => `${m.exposurePct.toFixed(1)}%`} />
                <MetricRow label="Fees paid" m={[o, is, oos]} f={(m) => formatUsd(m.feesPaid)} />
              </tbody>
            </table>
          </TableWrap>
        </Panel>

        <div className="ql-side">
          <Panel title="Assumptions used">
            <div className="lx-pad">
              <Kv
                rows={[
                  ['Execution', 'Next bar open'],
                  ['Fee', <span className="num">{a.feeBps} bps / side</span>],
                  ['Slippage', <span className="num">{a.slippageBps} bps / side</span>],
                  ['Allocation', <span className="num">{round(a.allocation * 100, 2)}% of equity</span>],
                  ['Stop at invalidation', a.useInvalidationStop ? 'On' : 'Off'],
                  ['Max hold', <span className="num">{a.maxHoldBars ? `${a.maxHoldBars} bars` : 'Off'}</span>],
                  ['Split', <span className="num">{round(a.inSampleFraction * 100, 1)}% in / {round(100 - a.inSampleFraction * 100, 1)}% out</span>],
                  ['Starting equity', <span className="num">{formatUsd(a.startingEquity, 0)}</span>],
                  ['Direction', 'Long only, spot'],
                ]}
              />
            </div>
          </Panel>
          <Panel title="Parameters">
            <div className="lx-pad">
              <Kv rows={Object.entries(r.params).map(([k, v]): [ReactNode, ReactNode] => [labelFor(k), <span className="num">{String(v)}</span>])} />
            </div>
          </Panel>
        </div>
      </div>

      <Panel title="Methodology" className="ql-method">
        <p className="ql-method-text">{run.methodology}</p>
      </Panel>

      <Panel title="Trades" note={<span className="num">{r.trades.length} closed</span>}>
        {r.trades.length ? (
          <TableWrap maxHeight={440} label="Backtest trades">
            <table className="table ql-trades">
              <thead>
                <tr>
                  <th scope="col" className="r">
                    #
                  </th>
                  <th scope="col">Segment</th>
                  <th scope="col">Entry</th>
                  <th scope="col" className="r">
                    Entry price
                  </th>
                  <th scope="col">Exit</th>
                  <th scope="col" className="r">
                    Exit price
                  </th>
                  <th scope="col" className="r">
                    Bars
                  </th>
                  <th scope="col">Reason</th>
                  <th scope="col" className="r">
                    Return
                  </th>
                  <th scope="col" className="r">
                    P&L
                  </th>
                  <th scope="col" className="r">
                    Fees
                  </th>
                </tr>
              </thead>
              <tbody>
                {r.trades.map((t, i) => (
                  <tr key={`${t.entryTime}-${i}`}>
                    <td className="r num muted">{i + 1}</td>
                    <td>{t.segment === 'in_sample' ? <span className="badge outline">In</span> : <span className="badge ql-badge-oos">Out</span>}</td>
                    <td className="num">{fmtTime(t.entryTime)}</td>
                    <td className="r num">{formatPrice(t.entryPrice)}</td>
                    <td className="num">{fmtTime(t.exitTime)}</td>
                    <td className="r num">{formatPrice(t.exitPrice)}</td>
                    <td className="r num">{t.bars}</td>
                    <td className={t.exitReason === 'stop' ? 'ql-reason-stop' : ''}>{EXIT_LABEL[t.exitReason]}</td>
                    <td className={`r num ${toneOf(t.returnPct)}`}>{formatPct(t.returnPct)}</td>
                    <td className={`r num ${toneOf(t.pnl)}`}>{formatUsd(t.pnl)}</td>
                    <td className="r num muted">{formatUsd(t.fees)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        ) : (
          <div className="empty">
            <strong>No completed trades</strong>
            <span>The strategy produced no entry that closed within this sample. Try more bars or a different timeframe.</span>
          </div>
        )}
      </Panel>
    </div>
  );
}

function MetricRow({ label, m, f, sub, tone, strong = false }: { label: string; m: SegmentMetrics[]; f: (m: SegmentMetrics) => ReactNode; sub?: (m: SegmentMetrics) => ReactNode; tone?: (m: SegmentMetrics) => string; strong?: boolean }) {
  return (
    <tr className={strong ? 'ql-row-strong' : undefined}>
      <th scope="row">{label}</th>
      {m.map((x, i) => (
        <td key={i} className={`r num ${tone?.(x) ?? ''} ${i === 2 ? 'ql-oos-col' : ''}`}>
          {f(x)}
          {sub ? <Sub>{sub(x)}</Sub> : null}
        </td>
      ))}
    </tr>
  );
}

// ═════════════════════════ Position & risk ═════════════════════════

function RiskTools() {
  const config = useApp((s) => s.config)!;
  const tickers = useApp((s) => s.tickers);
  const layoutMarket = useApp((s) => s.layout.market);
  const [market, setMarket] = useState(layoutMarket);
  const t = tickers[market];
  const px = t?.price ?? null;
  const seed = (p: number | null, mult: number) => (p ? Number(formatPrice(p * mult).replace(/,/g, '')) : NaN);

  const [ps, setPs] = useState(() => ({ account: 10_000, riskPct: 1, entry: seed(px, 1), stop: seed(px, 0.98), feeBps: DEFAULT_ASSUMPTIONS.feeBps }));
  const [rr, setRr] = useState(() => ({ entry: seed(px, 1), stop: seed(px, 0.98), target: seed(px, 1.04), feeBps: DEFAULT_ASSUMPTIONS.feeBps }));
  const prefill = () => {
    if (!px) return;
    setPs((s) => ({ ...s, entry: seed(px, 1), stop: seed(px, 0.98) }));
    setRr((s) => ({ ...s, entry: seed(px, 1), stop: seed(px, 0.98), target: seed(px, 1.04) }));
  };

  const size = positionSize({ accountSize: ps.account, riskPct: ps.riskPct, entry: ps.entry, stop: ps.stop, feeBps: ps.feeBps });
  const rrr = riskReward({ entry: rr.entry, stop: rr.stop, target: rr.target, feeBps: rr.feeBps });
  const base = getMarket(market)?.base ?? '';
  const actualRisk = size.quantity * size.perUnitRisk;

  return (
    <div className="ql-risk">
      <div className="ql-risk-bar">
        <label className="field ql-risk-mkt">
          Reference market
          <select className="input" value={market} onChange={(e) => setMarket(e.target.value)}>
            {config.markets.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </label>
        <div className="ql-risk-px">
          <span className="eyebrow">Last price</span>
          <span className="num">{formatPrice(px)}</span>
          {t ? <span className="lx-sub">{new Date(t.time).toLocaleTimeString(undefined, { hour12: false })}</span> : null}
        </div>
        <button className="btn" onClick={prefill} disabled={!px}>
          Prefill from last price
        </button>
        <span className="ql-risk-note">Prefill sets a stop 2% below and a target 4% above — placeholders, not recommendations.</span>
      </div>

      <div className="ql-risk-grid">
        <Panel title="Position size" note="Fixed-fractional · spot long">
          <div className="ql-calc">
            <div className="ql-calc-in">
              <NumField label="Account size" unit="USD" value={ps.account} step={100} min={0} onChange={(v) => setPs({ ...ps, account: v })} />
              <NumField label="Risk per trade" unit="% of account" value={ps.riskPct} step={0.25} min={0} max={100} onChange={(v) => setPs({ ...ps, riskPct: v })} />
              <NumField label="Entry" unit="price" value={ps.entry} step="any" onChange={(v) => setPs({ ...ps, entry: v })} />
              <NumField label="Stop" unit="price" value={ps.stop} step="any" onChange={(v) => setPs({ ...ps, stop: v })} />
              <NumField label="Fees" unit="bps / side" value={ps.feeBps} step={1} min={0} onChange={(v) => setPs({ ...ps, feeBps: v })} />
            </div>
            <div className="ql-calc-out" aria-live="polite">
              {size.error ? (
                <div className="callout warn">
                  <IconAlert size={14} />
                  <span>{size.error}</span>
                </div>
              ) : (
                <>
                  <div className="ql-big">
                    <span className="eyebrow">Quantity</span>
                    <span className="ql-big-v num">
                      {formatQty(size.quantity, 6)} <span className="muted">{base}</span>
                    </span>
                  </div>
                  <Kv
                    rows={[
                      ['Notional', <span className="num">{formatUsd(size.notional)}</span>],
                      ['Share of account', <span className="num">{(size.leverageImplied * 100).toFixed(1)}%</span>],
                      ['Risk budget', <span className="num">{formatUsd(size.riskAmount)}</span>],
                      ['Loss if stopped', <span className="num down">{formatUsd(-actualRisk)}</span>],
                      ['Risk per unit (incl. fees)', <span className="num">{formatPrice(size.perUnitRisk)}</span>],
                    ]}
                  />
                  {size.capped ? (
                    <div className="callout warn">
                      <IconAlert size={14} />
                      <span>The risk-based size exceeds the account, so it is capped at 100% (spot, no leverage). Actual risk at the stop is {formatUsd(actualRisk)}.</span>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </Panel>

        <Panel title="Risk / reward" note="Spot long · fees both sides">
          <div className="ql-calc">
            <div className="ql-calc-in">
              <NumField label="Entry" unit="price" value={rr.entry} step="any" onChange={(v) => setRr({ ...rr, entry: v })} />
              <NumField label="Stop" unit="price" value={rr.stop} step="any" onChange={(v) => setRr({ ...rr, stop: v })} />
              <NumField label="Target" unit="price" value={rr.target} step="any" onChange={(v) => setRr({ ...rr, target: v })} />
              <NumField label="Fees" unit="bps / side" value={rr.feeBps} step={1} min={0} onChange={(v) => setRr({ ...rr, feeBps: v })} />
            </div>
            <div className="ql-calc-out" aria-live="polite">
              {rrr.error ? (
                <div className="callout warn">
                  <IconAlert size={14} />
                  <span>{rrr.error}</span>
                </div>
              ) : (
                <>
                  <div className="ql-big">
                    <span className="eyebrow">Reward : risk</span>
                    <span className="ql-big-v num">
                      {rrr.ratio.toFixed(2)}
                      <span className="muted"> R</span>
                    </span>
                  </div>
                  <div className="ql-rr" aria-hidden>
                    <div className="ql-rr-track">
                      <span className="ql-rr-risk" style={{ flexGrow: rrr.risk }} />
                      <span className="ql-rr-entry" />
                      <span className="ql-rr-reward" style={{ flexGrow: rrr.reward }} />
                    </div>
                    <div className="ql-rr-labels num" style={{ gridTemplateColumns: `minmax(max-content, ${rrr.risk}fr) minmax(max-content, ${rrr.reward}fr)` }}>
                      <span>{formatPrice(rr.stop)}</span>
                      <span className="ql-rr-lr">
                        <b>{formatPrice(rr.entry)}</b>
                        <span>{formatPrice(rr.target)}</span>
                      </span>
                    </div>
                  </div>
                  <Kv
                    rows={[
                      ['Risk (incl. fees)', <span className="num down">{formatPct(-rrr.riskPct)}</span>],
                      ['Reward (net of fees)', <span className="num up">{formatPct(rrr.rewardPct)}</span>],
                      ['Breakeven winning-trade share', <strong className="num">{(rrr.breakevenWinRate * 100).toFixed(1)}%</strong>],
                    ]}
                  />
                  <p className="ql-fine">
                    At {rrr.ratio.toFixed(2)} R you must win more than {(rrr.breakevenWinRate * 100).toFixed(1)}% of trades like this to break even after fees. This is arithmetic, not a
                    forecast.
                  </p>
                </>
              )}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
