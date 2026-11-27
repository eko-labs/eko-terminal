import { useEffect, useState } from 'react';
import type { RadarRow } from '@eko/shared';
import { GlanceTile } from '../../components/GlanceTile';
import { KeyFact } from '../../components/KeyFact';
import { ApiError } from '../../lib/api';
import { changeText, fallOf, GROUP_LABEL, keepLine, loadDump, NOT_MEASURED, sentence, shareText, summaryOf, tokensText, toneOf, VENUE, type Dump, type Figure } from './model';
import './dump-test.css';

/**
 * The dump test on screen: a glance tile right after the verdict, a key fact on Simple's coin page, a section at the top
 * of the Overview tab with each insider group as a pixel bar, and a figure in every coin list row. The coin page parts
 * read GET /v2/coins/:address/dump (model.ts, shared and refreshed while open); the rows read the figure the list has.
 */
const REFRESH_MS = 45_000;
function useDump(coin: string) {
  const [state, setState] = useState<{ reply: Dump | null; error: string | null; loading: boolean }>({ reply: null, error: null, loading: true });
  useEffect(() => {
    let live = true;
    setState({ reply: null, error: null, loading: true });
    const read = () => loadDump(coin).then(reply => { if (live) setState({ reply, error: null, loading: false }); })
      .catch((e: unknown) => { if (live) setState(s => s.reply ? s : { reply: null, loading: false, error: e instanceof ApiError && e.status === 404 && e.message ? e.message : 'The dump test is not available right now. Try again in a minute.' }); });
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [coin]);
  return state;
}

const TARGET = { tab: 'Overview' as const, section: 'dump-test' };
const TILE_TITLE = 'EKO estimates how far the price would fall if the coin\'s insiders sold everything they hold at once, and what $100 held now would then be worth, fees included.';

/** The glance tile: "If insiders dump", −83%, "$100 → $17", coloured by how far. */
export function DumpGlance({ coin }: { coin: string }) {
  const { reply, loading } = useDump(coin);
  if (loading) return <GlanceTile label="If insiders dump" value="" loading target={TARGET} />;
  return <DumpTile reply={reply} />;
}
export function DumpTile({ reply }: { reply: Dump | null }) {
  const a = reply?.measured ? reply.all : null;
  if (!a || a.changePct === null || a.usd100 === null) return null;
  const tone = toneOf(a.changePct);
  return <GlanceTile label="If insiders dump" value={<span className={`dt-v dt-${tone}`}>{changeText(a.changePct)}</span>} line={keepLine(a.usd100)} tone={tone}
    gauge={fallOf(a.changePct)} target={TARGET} title={TILE_TITLE} />;
}

/** Simple's key fact: the same figure, in its list of facts. */
export function DumpFact({ coin }: { coin: string }) {
  return <DumpFactView reply={useDump(coin).reply} />;
}
export function DumpFactView({ reply }: { reply: Dump | null }) {
  const a = reply?.measured ? reply.all : null;
  if (!a || a.changePct === null || a.usd100 === null) return null;
  return <KeyFact label="If insiders dump" value={changeText(a.changePct)} line={keepLine(a.usd100)} tone={toneOf(a.changePct)} title={TILE_TITLE} />;
}

/** A fall as a row of pixel bars, lit in its tone. */
const CELLS = 30;
export function DumpBar({ changePct, strong = false }: { changePct: number; strong?: boolean }) {
  const f = fallOf(changePct), lit = f > 0 ? Math.max(1, Math.round(CELLS * f / 100)) : 0;
  return <span className={`dt-bar dt-${toneOf(changePct)}${strong ? ' dt-bar-all' : ''}`} aria-hidden="true">
    {Array.from({ length: CELLS }, (_, i) => <i key={i} className={i < lit ? 'on' : undefined} />)}
  </span>;
}

function GroupRow({ g }: { g: Figure }) {
  const all = g.id === 'all', held = g.wallets === 0 ? 'none held' : `${tokensText(g.tokens)} · ${shareText(g.sharePct)} of supply`;
  return <li className={`dt-row${all ? ' dt-all' : ''}${g.wallets === 0 ? ' dt-empty' : ''}`}>
    <span className="dt-label">{GROUP_LABEL[g.id]}</span>
    {g.changePct === null ? <span className="dt-bar dt-none" aria-hidden="true" /> : <DumpBar changePct={g.changePct} strong={all} />}
    <span className={`dt-pct num${g.changePct === null ? '' : ` dt-${toneOf(g.changePct)}`}`}>{g.changePct === null ? '—' : changeText(g.changePct)}</span>
    <span className="dt-held num">{held}{g.wallets > 1 && <span className="dt-n"> · {g.wallets} wallets</span>}</span>
  </li>;
}

/** The section: one sentence, then each group selling alone and all insiders at once. */
export function DumpSection({ coin }: { coin: string }) {
  const { reply, error } = useDump(coin);
  if (error) return <p className="dt-note">{error}</p>;
  if (!reply) return <div className="skel dt-skel" aria-label="Loading the dump test" />;
  return <DumpView reply={reply} />;
}
export function DumpView({ reply }: { reply: Dump }) {
  if (!reply.measured) return <p className="dt-lead">{NOT_MEASURED[reply.reason]}</p>;
  const a = reply.all;
  return <div className="dt">
    <p className="dt-lead">{sentence(reply)}</p>
    {a.wallets > 0 && <>
      <ul className="dt-rows" aria-label="Price change if each group sold everything it holds">
        {reply.groups.map(g => <GroupRow key={g.id} g={g} />)}
        <GroupRow g={a} />
      </ul>
      {a.usd100 !== null && a.changePct !== null && <p className={`dt-keep dt-${toneOf(a.changePct)}`}><span>Your $100</span><b className="num">{keepLine(a.usd100).replace('$100 ', '')}</b><span className="dt-keep-note">if all insiders sold first{reply.sellFeePct ? `, after the ${Number(reply.sellFeePct.toFixed(2))}% sell fee` : ', fees included'}</span></p>}
    </>}
    <p className="dt-note">
      An estimate, not a forecast. Each line is one group selling alone; All insiders is all of them at once. EKO counts
      insider balances from the coin's own transfers{reply.funding ? '' : ' (dev-funded wallets show once EKO has traced who funded them)'}, and prices the
      sale on {VENUE[reply.venue]} as it is now.
    </p>
  </div>;
}

/** A coin list row's figure: −83% in its tone, or a quiet dash. */
export function DumpCell({ row }: { row: RadarRow }) {
  const s = summaryOf(row);
  if (!s) return <span className="dt-cell dt-none" title="No dump test for this coin yet">—</span>;
  return <span className={`dt-cell dt-${toneOf(s.changePct)}`} title={`If insiders dump: ${changeText(s.changePct)} · ${keepLine(s.usd100)} (EKO estimates)`}>{changeText(s.changePct)}</span>;
}

export default DumpSection;
