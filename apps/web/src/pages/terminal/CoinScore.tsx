import { EKO_SCORE_BAND_LABEL, EKO_SCORE_BANDS, EKO_SCORE_WEIGHTS, type EkoScore } from '@eko/shared';

/**
 * The EKO score on screen (@eko/shared score.ts): one number whose band always matches the verdict. The band word and
 * colour come with every number: coral for Danger, Monitor ice for Be careful, the accent blue for Looks OK.
 */
export const SCORE_TITLE = 'EKO score. Danger is always 0-39, Be careful 40-69, Looks OK 70-100; higher inside a band means a stronger setup.';
/** The verdict each band follows, as the verdict chip says it. */
export const SCORE_VERDICT: Record<EkoScore['band'], string> = { danger: 'Danger', careful: 'Be careful', ok: 'Looks OK' };
export const SCORE_PARTS = [
  { id: 'momentum', label: 'Momentum', hint: 'The hour’s move, volume against its usual hour, and buys against sells' },
  { id: 'money', label: 'Money behind it', hint: 'Liquidity against market cap (on a curve: how far along it is) and pool depth' },
  { id: 'holders', label: 'Holder spread', hint: 'How much the top 10, the dev and the early wallets hold: less is better' },
  { id: 'exit', label: 'Easy to exit', hint: 'The cost of buying $1K and selling it straight back, and the sell check' },
] as const satisfies readonly { id: keyof EkoScore['parts']; label: string; hint: string }[];

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Why the score sits where it does, in one plain line. */
export function scoreWhy(score: EkoScore): string {
  const cap = score.cap ?? EKO_SCORE_BANDS[score.band][1], verdict = SCORE_VERDICT[score.band];
  if (score.band === 'ok' && cap >= 100) return 'EKO says Looks OK: no red flags in its checks. Higher means a stronger setup.';
  return `Capped at ${cap}: EKO says ${verdict}${score.cappedBy ? `, ${lower(score.cappedBy)}` : ''}.`;
}

/** A row of dithered pixel cells, `value` of 100 lit, in the band's colour. */
export function ScorePixels({ value, band, cells = 10, dim = false }: { value: number; band: EkoScore['band']; cells?: number; dim?: boolean }) {
  const lit = Math.max(value > 0 ? 1 : 0, Math.round(cells * Math.min(100, Math.max(0, value)) / 100));
  return <span className={`score-px score-${band}${dim ? ' score-dim' : ''}`} aria-hidden="true">{Array.from({ length: cells }, (_, i) => <i key={i} className={i < lit ? 'on' : undefined} />)}</span>;
}

/** Radar's Score cell: "31 · Danger" over a small pixel bar. */
export function ScoreCell({ score }: { score: EkoScore }) {
  const word = EKO_SCORE_BAND_LABEL[score.band];
  return <span className={`rt-score score-${score.band}`} title={`${SCORE_TITLE} ${scoreWhy(score)}`} aria-label={`EKO score ${score.value}, ${SCORE_VERDICT[score.band]}`}>
    <span className="rt-score-top"><b className="num">{score.value}</b><span className="score-word">{word}</span></span>
    <ScorePixels value={score.value} band={score.band} />
  </span>;
}

/** On a narrow Radar (the Score column hidden) the score rides on the ticker line: the number and its band word. */
export function ScoreMini({ score }: { score: EkoScore }) {
  return <span className={`rt-score-mini score-${score.band}`} title={`${SCORE_TITLE} ${scoreWhy(score)}`}><b className="num">{score.value}</b>{EKO_SCORE_BAND_LABEL[score.band]}</span>;
}

/** The 0-100 ruler: three bands, the coin's lit, a tick where it sits. */
function ScoreRuler({ score }: { score: EkoScore }) {
  return <span className="score-ruler" aria-hidden="true">{(['danger', 'careful', 'ok'] as const).map(band => {
    const [lo, hi] = EKO_SCORE_BANDS[band];
    return <span key={band} className={`score-seg score-${band}${band === score.band ? ' on' : ''}`} style={{ flexGrow: hi - lo + 1 }}>
      {band === score.band && <i style={{ left: `${(score.value - lo) / (hi - lo + 1) * 100}%` }} />}
    </span>;
  })}</span>;
}

/** The score's parts, each with its pixel gauge; a part without data is marked and counts as 50. */
export function ScoreParts({ score, cells = 20 }: { score: EkoScore; cells?: number }) {
  return <dl className="score-parts">{SCORE_PARTS.map(p => {
    const missing = score.missing?.includes(p.id);
    return <div key={p.id} title={`${p.hint}. Weight ${Math.round(EKO_SCORE_WEIGHTS[p.id] * 100)}%.`}>
      <dt>{p.label}</dt>
      <dd><ScorePixels value={score.parts[p.id]} band={score.band} cells={cells} dim={missing} /><span className="num">{missing ? 'not measured' : score.parts[p.id]}</span></dd>
    </div>;
  })}</dl>;
}

/** The coin page's score panel: the number and its band, the ruler, the four parts and the line that says why. */
export function CoinScorePanel({ score }: { score: EkoScore }) {
  return <section className={`panel coin-score score-${score.band}`} aria-labelledby="coin-score-h">
    <div className="panel-body">
      <div className="coin-score-head">
        <h3 id="coin-score-h" className="eyebrow" title={SCORE_TITLE}>EKO score</h3>
        <p className="coin-score-figure"><b className="num">{score.value}</b><span className="score-word">{SCORE_VERDICT[score.band]}</span></p>
        <ScoreRuler score={score} />
        <p className="coin-score-why">{scoreWhy(score)}</p>
      </div>
      <ScoreParts score={score} />
    </div>
    <p className="coin-score-note">Danger is always 0‑39, Be careful 40‑69, Looks OK 70‑100. Inside its band a coin sits by its setup. Not a recommendation.</p>
  </section>;
}
