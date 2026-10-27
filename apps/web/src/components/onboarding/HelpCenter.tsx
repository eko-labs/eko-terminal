import { useEffect, useMemo, useRef, useState } from 'react';
import { PAPER_STARTING_CASH } from '@eko/shared';
import { navigate } from '../../lib/router';
import { useMedia } from '../../lib/useMedia';
import { useApp } from '../../store/app';
import { useOnboarding } from '../../store/onboarding';
import { SHORTCUTS } from '../Command';
import { IconClose, IconReplay, IconSearch } from '../icons';
import { GlossTube } from './art';
import { ChecklistSteps, useChecklistProgress } from './Checklist';
import { searchTerms } from './glossary';
import { TOUR_STEPS } from './steps';
import { Term } from './Term';
import { prefersReducedMotion, useDialog } from './useDialog';

const SECTIONS = [
  { id: 'start', label: 'Getting started' },
  { id: 'how', label: 'How it works' },
  { id: 'modes', label: 'Paper vs Live' },
  { id: 'glossary', label: 'Glossary' },
  { id: 'keys', label: 'Shortcuts' },
  { id: 'safety', label: 'Safety' },
] as const;


const cash = `$${PAPER_STARTING_CASH.toLocaleString('en-US')}`;

export default function HelpCenter() {
  const close = useOnboarding((s) => s.closeHelp);
  const section = useOnboarding((s) => s.helpSection);
  const startTour = useOnboarding((s) => s.startTour);
  const requestLiveMode = useOnboarding((s) => s.requestLiveMode);
  const restoreChecklist = useOnboarding((s) => s.restoreChecklist);
  const dismissed = useOnboarding((s) => s.checklistDismissed);
  const restart = useOnboarding((s) => s.restart);
  const config = useApp((s) => s.config);
  const isMobile = useMedia('(max-width: 900px)');
  const { done, total, complete } = useChecklistProgress();
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useDialog(ref, { onEscape: close });

  const terms = useMemo(() => searchTerms(q), [q]);
  const liveRoutes = (config?.markets ?? []).filter((m) => m.routes.live).map((m) => `${m.base} ⇄ ${m.routes.live!.quote.symbol}`);

  const jump = (id: string) => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-help-section="${id}"]`);
    el?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    el?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (section) window.setTimeout(() => jump(section), 60);
  }, [section]);

  const replay = () => {
    if (location.pathname !== '/radar') navigate('/radar');
    startTour();
  };

  return (
    <div className="ob-root ob-help-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} className="ob-help" role="dialog" aria-modal="true" aria-labelledby="ob-help-title" data-testid="help-centre">
        <header className="ob-help-head">
          <GlossTube variant="wave" size={150} width={30} className="ob-help-art" />
          <div>
            <h2 id="ob-help-title">Help & guide</h2>
            <span className="muted">How EKO works, in plain words.</span>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close help" data-testid="help-close">
            <IconClose size={15} />
          </button>
        </header>

        <div className="ob-help-search">
          <IconSearch size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the glossary…" aria-label="Search the glossary" data-testid="help-search" />
          {q ? (
            <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear search">
              <IconClose size={12} />
            </button>
          ) : null}
        </div>

        {!q ? (
          <nav className="ob-help-nav" aria-label="Help sections">
            {SECTIONS.filter((s) => !(isMobile && s.id === 'keys')).map((s) => (
              <button key={s.id} className="ob-chip ob-chip--btn" onClick={() => jump(s.id)}>
                {s.label}
              </button>
            ))}
          </nav>
        ) : null}

        <div className="ob-help-body" ref={bodyRef}>
          {q ? (
            <section className="ob-help-sec" aria-label="Search results">
              <p className="muted ob-help-count" aria-live="polite">
                {terms.length ? `${terms.length} term${terms.length === 1 ? '' : 's'}` : `Nothing matches “${q}”.`}
              </p>
              <Glossary terms={terms} />
            </section>
          ) : (
            <>
              <div className="ob-help-actions">
                <button className="ob-action" onClick={replay} data-testid="help-replay">
                  <span className="ob-action-ico">
                    <IconReplay size={16} />
                  </span>
                  <span>
                    <strong>Replay the tour</strong>
                    <span className="muted">{TOUR_STEPS.length} quick stops</span>
                  </span>
                </button>
                <button className="ob-action ob-action--live" onClick={requestLiveMode} data-testid="help-live">
                  <span className="ob-action-ico">
                    <span className="dot" />
                  </span>
                  <span>
                    <strong>Live setup guide</strong>
                    <span className="muted">What changes, what you need</span>
                  </span>
                </button>
              </div>

              <section className="ob-help-sec" data-help-section="start" tabIndex={-1} aria-labelledby="h-start">
                <h3 id="h-start">
                  Getting started <span className="num muted">{done}/{total}</span>
                </h3>
                {isMobile ? (
                  <ChecklistSteps />
                ) : (
                  <p>
                    {complete ? 'You’ve done the whole loop on paper. ' : `${done} of ${total} steps done. `}
                    {dismissed ? (
                      <button className="linkish" onClick={() => (restoreChecklist(), close())}>
                        Show the checklist again
                      </button>
                    ) : (
                      'The checklist sits in the bottom-left corner of Trade.'
                    )}
                  </p>
                )}
              </section>

              <section className="ob-help-sec" data-help-section="how" tabIndex={-1} aria-labelledby="h-how">
                <h3 id="h-how">How EKO works</h3>
                <ul className="ob-points">
                  <li>Radar shows observations, scam playbooks and evidence.</li>
                  <li>Review the guard and your policy before placing an order.</li>
                  <li>Rule Lab compiles standing instructions into rules for deterministic backtests.</li>
                </ul>
              </section>

              <section className="ob-help-sec" data-help-section="modes" tabIndex={-1} aria-labelledby="h-modes">
                <h3 id="h-modes">Paper vs Live</h3>
                <table className="ob-compare">
                  <thead>
                    <tr>
                      <th scope="col">
                        <span className="sr-only">Topic</span>
                      </th>
                      <th scope="col" className="is-paper">
                        Paper
                      </th>
                      <th scope="col" className="is-live">
                        Live
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">Money</th>
                      <td>{cash} of paper money</td>
                      <td>Real funds in your own wallet</td>
                    </tr>
                    <tr>
                      <th scope="row">Where</th>
                      <td>Simulated on live prices</td>
                      <td>Elysium mainnet (99901), Uniswap v4 (trading opens later)</td>
                    </tr>
                    <tr>
                      <th scope="row">Markets</th>
                      <td>All markets</td>
                      <td>{liveRoutes.length ? liveRoutes.join(', ') : 'ETH ⇄ USDG'} only</td>
                    </tr>
                    <tr>
                      <th scope="row">Costs</th>
                      <td>0.10% modelled fee</td>
                      <td>
                        Pool fee + <Term id="gas">gas</Term> in ETH
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">A tap</th>
                      <td>Fills at once</td>
                      <td>
                        Your wallet signs it (buys first <Term id="approval">approve the exact USDG</Term>)
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Status</th>
                      <td>Filled</td>
                      <td>Submitted, then confirmed once the receipt is checked</td>
                    </tr>
                  </tbody>
                </table>
                <p>
                  Both are <Term id="spot_only">spot only</Term>: you can only sell what you hold. Paper and live records are always kept separate.
                </p>
                <button className="btn sm ob-live-btn" onClick={requestLiveMode}>
                  Open the Live setup guide
                </button>
              </section>

              <section className="ob-help-sec" data-help-section="glossary" tabIndex={-1} aria-labelledby="h-glossary">
                <h3 id="h-glossary">Glossary</h3>
                <Glossary terms={terms} />
              </section>

              {!isMobile ? (
                <section className="ob-help-sec" data-help-section="keys" tabIndex={-1} aria-labelledby="h-keys">
                  <h3 id="h-keys">Keyboard shortcuts</h3>
                  <dl className="ob-keys">
                    {SHORTCUTS.map(({ keys, label }) => (
                      <div key={label}>
                        <dt>
                          <span className="kbd">{keys}</span>
                        </dt>
                        <dd>{label}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}

              <section className="ob-help-sec" data-help-section="safety" tabIndex={-1} aria-labelledby="h-safety">
                <h3 id="h-safety">Safety & disclaimers</h3>
                <ul className="ob-safety">
                  <li>
                    <b>Not investment advice.</b> Observations are information. You decide, and you’re responsible for your trades.
                  </li>
                  <li>Model outputs can be wrong. Review their evidence.</li>
                  <li>Past or backtested results don’t predict future results.</li>
                  <li>
                    <b>Your keys, your funds.</b> EKO never holds funds or keys and will never ask for your seed phrase.
                  </li>
                  <li>
                    Nothing trades automatically: every trade needs your tap, and on Live your wallet’s signature. Approvals are for the exact amount only. Live trades over your
                    large-trade limit (Settings) ask for one more tap.
                  </li>
                  <li>A live order isn’t a trade until it’s confirmed on-chain. Transactions can fail, or fill anywhere within your slippage limit.</li>
                  <li>EKO is an independent app on Elysium — not a Kinetiq or Hyperliquid product.</li>
                </ul>
              </section>

              <footer className="ob-help-foot">
                <button className="linkish" onClick={restart}>
                  Start onboarding over
                </button>
                <span className="muted num">EKO {config?.version ?? ''}</span>
              </footer>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Glossary({ terms }: { terms: ReturnType<typeof searchTerms> }) {
  return (
    <dl className="ob-glossary" data-testid="glossary">
      {terms.map((t) => (
        <div key={t.id} id={`g-${t.id}`}>
          <dt>{t.term}</dt>
          <dd>
            {t.short}
            {t.more ? <span className="ob-more"> {t.more}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
