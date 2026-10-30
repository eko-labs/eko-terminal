import { visibleDrops } from '@eko/shared';
import { useShell } from '../store/shell';
import './drops.css';

const targetDate = (date: string) => new Intl.DateTimeFormat('en', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${date}T00:00:00Z`));

export default function Drops() {
  const config = useShell(state => state.config);
  const error = useShell(state => state.configError);
  const drops = visibleDrops(config?.drops ?? [], config?.flags ?? {});
  return <div className="shell-page drops-page">
    <header className="page-head"><span className="eyebrow">Recorded demos</span><h1>Drops</h1>
      <p>Explore built and demoed features. Target dates can move.</p></header>
    {!config ? <p role="status">{error ? 'Drops are unavailable. Try again when the connection returns.' : 'Loading Drops…'}</p>
      : drops.length === 0 ? <div className="drops-empty" role="status"><h2>No recorded Drop demos yet</h2>
        <p>Drops appear here when a working demo has been recorded.</p></div>
        : <div className="drops-list">{drops.map((drop, i) => <article className="drop-card" key={`${drop.n}-${i}`}>
          <span className="eyebrow">Drop {drop.n}</span><h2>{drop.title}</h2>
          <p>{drop.status === 'live' ? 'Live' : <>Built and demoed · shipping in Drop {drop.n} (target <time dateTime={drop.date}>{targetDate(drop.date)}</time>)</>}</p>
          <video controls playsInline preload="none" src={drop.demo.videoUrl} aria-label={`Drop ${drop.n}: ${drop.title} demo`}>
            <a href={drop.demo.videoUrl}>Download demo video</a>
          </video>
          {drop.status === 'live' && drop.release && <p className="drop-release"><a href={drop.release.url} rel="noreferrer">Published release: {drop.release.version}</a></p>}
        </article>)}</div>}
  </div>;
}
