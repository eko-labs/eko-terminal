import { useCallback, useEffect, useRef, useState } from 'react';
import { NETWORK_FOR_MODE, formatMs } from '@eko/shared';
import { api } from '../lib/api';
import { localStats } from '../lib/telemetry';
import { useApp } from '../store/app';
import { useOnboarding } from '../store/onboarding';
import { useOutside } from './hooks';
import { IconAlert, IconCheck, IconClose, IconInfo } from './icons';

interface ServerMetric {
  metric: string;
  p50: number | null;
  count: number;
}

/** "Connected" with a popover of what's behind it: stream, market data, execution latency, AI, network. */
function ConnectionStatus() {
  const health = useApp((s) => s.health);
  const wsState = useApp((s) => s.wsState);
  const config = useApp((s) => s.config);
  const [open, setOpen] = useState(false);
  const [m, setM] = useState<Record<string, ServerMetric>>({});
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutside(ref, close, open);
  useEffect(() => {
    if (!open) return;
    const load = () =>
      api<{ metrics: ServerMetric[] }>('/metrics')
        .then((r) => setM(Object.fromEntries(r.metrics.map((x) => [x.metric, x]))))
        .catch(() => undefined);
    void load();
    const t = window.setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [open]);
  const connected = wsState === 'open';
  const tone = connected ? 'ok' : 'warn';
  const rtt = localStats('ws.rtt_ms');
  const aiOn = health?.providers.filter((p) => p.configured).length ?? 0;
  const net = health?.networks.find((n) => n.id === NETWORK_FOR_MODE.live);
  const rows: [string, string][] = [
    ['Live stream', connected ? `Connected · ${rtt ? formatMs(rtt.p50) : '—'} round trip` : 'Reconnecting…'],
    ['Quotes (median)', formatMs(m['quote.latency_ms']?.p50)],
    ['Orders (median)', formatMs(m['order.submit_server_ms']?.p50)],
    ['AI providers', `${aiOn} connected`],
    ['Elysium', net ? `${net.status}${net.blockNumber ? ` · block ${net.blockNumber.toLocaleString()}` : ''}` : '—'],
    ['Version', config?.version ?? '—'],
  ];
  return (
    <div className="sb-conn" ref={ref}>
      <button className={`sb-item sb-btn tone-${tone}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" data-testid="stream-status">
        <span className="sb-dot" /> {connected ? 'Connected' : 'Reconnecting…'}
      </button>
      {open ? (
        <div className="menu sb-pop" role="dialog" aria-label="Connection details">
          <div className="menu-label">Connection</div>
          <dl className="sb-rows">
            {rows.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd className="num">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

/** Footer: the connection (details on click), and Help. */
export function StatusBar() {
  return (
    <footer className="statusbar" aria-label="Status">
      <ConnectionStatus />
      <span className="grow" />
      <button className="sb-link" onClick={() => useOnboarding.getState().openHelp()}>
        Help
      </button>
    </footer>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts" role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span className="toast-ico">{t.kind === 'ok' ? <IconCheck size={14} /> : t.kind === 'info' ? <IconInfo size={14} /> : <IconAlert size={14} />}</span>
          <div>
            <strong>{t.title}</strong>
            {t.body ? <p>{t.body}</p> : null}
            {t.action ? (
              <button
                className="btn sm toast-action"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
          <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <IconClose size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
