import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnect, useConnection, useConnectors } from 'wagmi';
import { GAS_RESERVE_ETH, NETWORKS, formatQty, shortAddress } from '@eko/shared';
import { api } from '../../lib/api';
import { ensureChain, isUserRejection, siweSignIn } from '../../lib/trade';
import { useApp } from '../../store/app';
import { useOnboarding } from '../../store/onboarding';
import { IconAlert, IconChart, IconCheck, IconClose, IconInfo, IconLock, IconWallet } from '../icons';
const MODE_LABEL = { paper: 'Paper', testnet: 'Testnet', live: 'Live' } as const;
import { StatusDot } from './art';
import { Term } from './Term';
import { useDialog } from './useDialog';

const NET = NETWORKS['elysium-mainnet'];
type Req = 'ok' | 'todo' | 'fail' | 'wait' | 'na';

function Changes({ routes }: { routes: string[] }) {
  const items: { icon: ReactNode; title: string; body: ReactNode }[] = [
    { icon: <IconWallet size={15} />, title: 'Real funds', body: 'Trades spend real assets from your own wallet. Losses are real too.' },
    {
      icon: <IconLock size={15} />,
      title: 'Your wallet signs',
      body: 'EKO never holds your funds or keys. Every trade needs your tap and a signature in your wallet — nothing is ever signed for you.',
    },
    {
      icon: <IconInfo size={15} />,
      title: 'Gas, paid in ETH',
      body: (
        <>
          Each transaction costs a small network fee (<Term id="gas">gas</Term>). Keep a little ETH in your wallet.
        </>
      ),
    },
    {
      icon: <IconCheck size={15} />,
      title: 'Exact approvals only',
      body: (
        <>
          Before spending <Term id="usdg">USDG</Term>, you <Term id="approval">approve</Term> exactly that trade’s amount — never an unlimited allowance.
        </>
      ),
    },
    {
      icon: <IconAlert size={15} />,
      title: 'Submitted isn’t confirmed',
      body: 'A trade is “submitted” when your wallet broadcasts it, and “confirmed” only once EKO has checked the on-chain receipt. It can still fail.',
    },
    {
      icon: <IconChart size={15} />,
      title: `${routes.length ? routes.join(', ') : 'ETH ⇄ USDG'} on Uniswap v3`,
      body: `Live trades go to Uniswap v3 on ${NET.name} mainnet (chain ${NET.chainId}). Other markets stay paper-only. Spot only — no shorting.`,
    },
  ];
  return (
    <ul className="ob-changes">
      {items.map((it) => (
        <li key={it.title}>
          <span className="ob-changes-ico" aria-hidden>
            {it.icon}
          </span>
          <span>
            <strong>{it.title}</strong>
            <span>{it.body}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function LiveSetup() {
  const close = useOnboarding((s) => s.closeLiveSetup);
  const introSeen = useOnboarding((s) => s.liveIntroSeen);
  const markLiveIntroSeen = useOnboarding((s) => s.markLiveIntroSeen);
  const markStep = useOnboarding((s) => s.markStep);
  const config = useApp((s) => s.config);
  const mode = useApp((s) => s.mode);
  const account = useApp((s) => s.account);
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, { onEscape: close });
  const [step, setStep] = useState(introSeen ? 1 : 0);
  const [ack, setAck] = useState(false);
  const [explain, setExplain] = useState(false);
  const enabled = !!config?.liveTradingEnabled;
  const routes = useMemo(() => (config?.markets ?? []).filter((m) => m.routes.live).map((m) => `${m.base} ⇄ ${m.routes.live!.quote.symbol}`), [config]);
  const stay = MODE_LABEL[mode === 'live' ? 'paper' : mode];

  // Focus the step's primary action whenever the step changes.
  useEffect(() => {
    const t = window.setTimeout(() => ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true }), 40);
    return () => clearTimeout(t);
  }, [step, explain]);

  const goLive = () => {
    useApp.getState().setMode('live');
    markLiveIntroSeen();
    markStep('go_live');
    close();
    useApp.getState().toast({ kind: 'info', title: 'Live mode is on', body: 'Start with a small amount. Every trade still needs your tap and your wallet’s signature.' });
  };

  const shell = (children: ReactNode) => (
    <div className="ob-root ob-scrim">
      <div ref={ref} className="ob-live" role="dialog" aria-modal="true" aria-labelledby="ob-live-title" data-testid="live-setup">
        <span className="ob-live-strip" aria-hidden />
        <button className="icon-btn ob-live-x" onClick={close} aria-label="Close">
          <IconClose size={14} />
        </button>
        {children}
      </div>
    </div>
  );

  if (mode === 'live')
    return shell(
      <>
        <span className="eyebrow ob-live-eyebrow">Live mode</span>
        <h2 id="ob-live-title">You’re trading live</h2>
        <p className="ob-lead">Real funds on {NET.name} mainnet. Each trade still needs your tap and a wallet signature.</p>
        <div className="modal-actions">
          <button className="btn" onClick={close}>
            Close
          </button>
          <button
            className="btn primary"
            data-autofocus
            onClick={() => {
              useApp.getState().setMode('paper');
              close();
            }}
          >
            Back to Paper
          </button>
        </div>
      </>,
    );

  if (!enabled)
    return shell(
      <>
        <span className="eyebrow ob-live-eyebrow">Live setup</span>
        <h2 id="ob-live-title">Live trading is off on this server</h2>
        <p className="ob-lead" data-testid="live-disabled">
          This EKO server has live execution switched off, so it won’t build or submit real transactions on {NET.name} mainnet. That’s the default until the operator
          has verified a first small real trade. You’re still on {stay} — nothing has changed.
        </p>
        <ul className="ob-points">
          <li>
            <b>Keep practising on Paper:</b> live prices, with <Term id="paper">paper money</Term>.
          </li>
          <li>When the operator turns Live on, this guide checks your wallet, network and gas before anything is real.</li>
        </ul>
        {explain ? <Changes routes={routes} /> : null}
        <div className="modal-actions">
          {!explain ? (
            <button className="btn ghost" onClick={() => (setExplain(true), markLiveIntroSeen())}>
              What would Live involve?
            </button>
          ) : null}
          <button className="btn primary" onClick={close} data-autofocus data-testid="live-stay">
            Stay on {stay}
          </button>
        </div>
      </>,
    );

  const STEPS = ['What changes', 'Requirements', 'Confirm'];
  return shell(
    <>
      <span className="eyebrow ob-live-eyebrow">Live setup</span>
      <h2 id="ob-live-title">{step === 0 ? 'Before you trade real funds' : step === 1 ? 'Check what you need' : 'Switch to Live'}</h2>
      <ol className="ob-steps" aria-label="Live setup steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'is-on' : i < step ? 'is-done' : ''} aria-current={i === step ? 'step' : undefined}>
            <span className="num">{i < step ? <IconCheck size={11} /> : i + 1}</span>
            {s}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <>
          <Changes routes={routes} />
          <div className="modal-actions">
            <button className="btn ghost" onClick={close} data-testid="live-stay">
              Stay on {stay}
            </button>
            <button
              className="btn primary"
              data-autofocus
              onClick={() => {
                markLiveIntroSeen();
                setStep(1);
              }}
            >
              Next: check requirements
            </button>
          </div>
        </>
      ) : step === 1 ? (
        <>
          <Requirements accountKind={account?.kind ?? null} accountWallet={account?.walletAddress ?? null} />
          <p className="fine ob-live-fine">You can switch now and finish these later — every trade checks them again first.</p>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setStep(0)}>
              Back
            </button>
            <button className="btn primary" onClick={() => setStep(2)} data-autofocus>
              Next
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="ob-lead">
            You’re switching to Live on {NET.name} mainnet. Every trade still needs your tap and your wallet’s signature — you can switch back to Paper at any time.
          </p>
          <label className="ob-ack">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="live-ack" data-autofocus />
            <span>I understand this uses real funds from my own wallet, and that EKO does not provide investment advice.</span>
          </label>
          <div className="ob-tip">
            <IconInfo size={14} />
            <span>
              <b>Start small.</b> Make your first live trade with an amount you’re comfortable losing, and keep a little ETH for gas.
            </span>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setStep(1)}>
              Back
            </button>
            <button className="btn ghost" onClick={close} data-testid="live-stay">
              Stay on {stay}
            </button>
            <button className="btn ob-live-go" onClick={goLive} disabled={!ack} data-testid="live-go">
              Switch to Live
            </button>
          </div>
        </>
      )}
    </>,
  );
}

/** Live status of everything a first live trade needs, with the fix for each one in place. Nothing is signed without a click. */
function Requirements({ accountKind, accountWallet }: { accountKind: 'guest' | 'wallet' | null; accountWallet: string | null }) {
  const config = useApp((s) => s.config);
  const refreshSession = useApp((s) => s.refreshSession);
  const toast = useApp((s) => s.toast);
  const conn = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'switch' | 'sign' | null>(null);
  const [eth, setEth] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; amount: number | null }>({ state: 'idle', amount: null });
  const address = conn.address;
  const onChain = !!address && conn.chainId === NET.chainId;
  const verified = !!address && accountKind === 'wallet' && accountWallet === address.toLowerCase();
  const unique = useMemo(() => {
    const seen = new Set<string>();
    return connectors.filter((c) => {
      const k = c.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [connectors]);

  useEffect(() => {
    if (!address) {
      setEth({ state: 'idle', amount: null });
      return;
    }
    let off = false;
    setEth({ state: 'loading', amount: null });
    api<{ balances: { symbol: string; amount: number }[] }>(`/api/chain/balances?mode=live&address=${address}`)
      .then((r) => !off && setEth({ state: 'ok', amount: r.balances.find((b) => b.symbol === 'ETH')?.amount ?? 0 }))
      .catch(() => !off && setEth({ state: 'error', amount: null }));
    return () => {
      off = true;
    };
  }, [address]);

  const signIn = async () => {
    setErr(null);
    setBusy('sign');
    try {
      await siweSignIn(NET.chainId);
      await refreshSession();
      toast({ kind: 'ok', title: 'Wallet verified', body: 'Signed in with Ethereum (EIP-4361).' });
    } catch (e) {
      setErr(isUserRejection(e) ? 'Signature rejected in your wallet.' : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const switchNet = async () => {
    setErr(null);
    setBusy('switch');
    try {
      await ensureChain(NET.chainId);
    } catch (e) {
      setErr(isUserRejection(e) ? 'Network switch rejected in your wallet.' : (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const rows: { key: string; state: Req; title: string; detail: ReactNode; action?: ReactNode }[] = [
    {
      key: 'server',
      state: config?.liveTradingEnabled ? 'ok' : 'fail',
      title: 'Live trading enabled on this server',
      detail: config?.liveTradingEnabled ? 'The operator has switched live execution on.' : 'The operator has live execution switched off.',
    },
    {
      key: 'wallet',
      state: address ? 'ok' : 'todo',
      title: 'Wallet connected',
      detail: address ? (
        <span className="num">
          {shortAddress(address)} · {conn.connector?.name}
        </span>
      ) : unique.length ? (
        'EKO never asks for seed phrases or private keys.'
      ) : (
        'No browser wallet found. Install an EVM wallet such as MetaMask, Rabby or OKX Wallet, then reload.'
      ),
      action: !address
        ? unique.map((c) => (
            <button
              key={c.uid}
              className="btn sm"
              onClick={() => {
                setErr(null);
                connect.mutate({ connector: c }, { onError: (e) => setErr(isUserRejection(e) ? 'Connection rejected in your wallet.' : e.message) });
              }}
              disabled={connect.isPending}
            >
              {connect.isPending && connect.variables?.connector === c ? <span className="spinner" /> : null}
              Connect {/^injected$/i.test(c.name) ? 'browser wallet' : c.name}
            </button>
          ))
        : null,
    },
    {
      key: 'network',
      state: !address ? 'na' : onChain ? 'ok' : 'todo',
      title: `On ${NET.name} (chain ${NET.chainId})`,
      detail: !address ? 'Connect a wallet first.' : onChain ? 'Your wallet is on the right network.' : `Your wallet is on chain ${conn.chainId ?? '—'}.`,
      action:
        address && !onChain ? (
          <button className="btn sm" onClick={() => void switchNet()} disabled={!!busy}>
            {busy === 'switch' ? <span className="spinner" /> : null}
            Switch network
          </button>
        ) : null,
    },
    {
      key: 'siwe',
      state: !address ? 'na' : verified ? 'ok' : 'todo',
      title: 'Signed in with your wallet',
      detail: verified ? 'Verified with Sign-In With Ethereum.' : 'A free signature that proves the wallet is yours. It doesn’t authorise any transaction or spending.',
      action:
        address && !verified ? (
          <button className="btn sm" onClick={() => void signIn()} disabled={!!busy}>
            {busy === 'sign' ? <span className="spinner" /> : null}
            Sign in
          </button>
        ) : null,
    },
    {
      key: 'gas',
      state: !address ? 'na' : eth.state === 'loading' ? 'wait' : eth.state === 'ok' ? ((eth.amount ?? 0) > GAS_RESERVE_ETH ? 'ok' : 'todo') : eth.state === 'error' ? 'na' : 'na',
      title: 'ETH for gas',
      detail: !address
        ? 'Connect a wallet first.'
        : eth.state === 'ok'
          ? (eth.amount ?? 0) > GAS_RESERVE_ETH
            ? <span className="num">{formatQty(eth.amount ?? 0, 5)} ETH on {NET.name}</span>
            : `Add a little ETH on ${NET.name} to pay network fees (more than ${GAS_RESERVE_ETH} ETH).`
          : eth.state === 'error'
            ? 'Couldn’t read your balance right now. It’s checked again before every trade.'
            : 'Checking your balance…',
    },
  ];

  return (
    <>
      <ul className="ob-reqs" data-testid="live-requirements">
        {rows.map((r) => (
          <li key={r.key} className={`ob-req ob-req--${r.state}`} data-req={r.key} data-state={r.state}>
            <StatusDot state={r.state} />
            <span className="ob-req-text">
              <strong>
                {r.title}
                <span className="sr-only"> — {r.state === 'ok' ? 'done' : r.state === 'fail' ? 'not available' : r.state === 'wait' ? 'checking' : r.state === 'na' ? 'not checked yet' : 'to do'}</span>
              </strong>
              <span className="ob-req-detail">{r.detail}</span>
            </span>
            {r.action ? <span className="ob-req-act">{r.action}</span> : null}
          </li>
        ))}
      </ul>
      {err ? (
        <div className="tk-alert" role="alert">
          <IconAlert size={14} />
          <span>{err}</span>
        </div>
      ) : null}
    </>
  );
}
