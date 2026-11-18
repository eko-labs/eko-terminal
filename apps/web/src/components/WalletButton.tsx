import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnect, useConnection, useConnectors, useDisconnect } from 'wagmi';
import { NETWORKS, shortAddress } from '@eko/shared';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { ensureChain, isUserRejection } from '../lib/trade';
import { useApp } from '../store/app';
import { useWalletState } from '../lib/walletState';
import { useOutside } from './hooks';
import { IconAlert, IconCheck, IconWallet } from './icons';
import { BUILD_NETWORK, deploymentMismatch } from '../lib/deployment';
import { useShell } from '../store/shell';
import { verifyWallet, useWalletVerification } from '../lib/walletVerification';
import { WALLET_COPY as C } from '../copy/wallet';
import { TRADE_COPY } from '../copy/trade';

export function WalletButton({ trade = false }: { trade?: boolean }) {
  const conn = useConnection();
  const chainId = conn.chainId;
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const account = useApp((s) => s.account);
  const mode = useApp((s) => s.mode);
  const refreshSession = useApp((s) => s.refreshSession);
  const { pending, failure } = useWalletVerification();
  const [open, setOpen] = useState(trade || useWalletState.getState().open);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutside(ref, close, open);
  useEffect(() => {
    if (trade) return;
    const h = () => setOpen(true);
    window.addEventListener('eko:open-wallet', h);
    return () => window.removeEventListener('eko:open-wallet', h);
  }, [trade]);
  // One chain per build: a wallet on any other chain is on the wrong network, whatever the trading mode.
  const target = mode === 'paper' ? null : BUILD_NETWORK;
  const mismatch = deploymentMismatch(useShell((s) => s.config));
  const wrong = !!conn.address && !!target && chainId !== target.chainId;
  const verified = !!conn.address && account?.kind === 'wallet' && account.walletAddress === conn.address.toLowerCase();
  const canVerify = !!conn.address && !verified && !mismatch;
  const verify = () => { if (conn.address) void verifyWallet(conn.address); };
  const verifyMessage = pending === conn.address?.toLowerCase() ? C.verifying : failure?.address === conn.address?.toLowerCase() ? failure?.message : null;
  const unique = useMemo(() => {
    const seen = new Set<string>();
    return connectors.filter((c) => {
      const k = c.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [connectors]);

  const connectWallet = async (connector: (typeof connectors)[number]) => {
    setErr(null);
    try {
      const { accounts: [address] } = await connect.mutateAsync({ connector });
      if (!trade) setOpen(true);
      // TODO(spec): §4.2 leaves prompt timing open. Prompt on an explicit connection, while restored connections and account changes use the Verify button.
      if (address) void verifyWallet(address, true);
    } catch (e) {
      setErr(isUserRejection(e) ? 'Connection rejected.' : (e as Error).message);
    }
  };
  const go = (p: string) => {
    setOpen(false);
    navigate(p);
  };

  if (trade && conn.address) return null;
  return (
    <div className={trade ? 'wallet tp-wallet-picker' : 'wallet'} ref={ref}>
      {!trade && canVerify && (
        <button type="button" className="btn btn-primary wallet-verify" aria-disabled={!!pending} onClick={verify}>
          {C.verify}
        </button>
      )}
      <button
        className={trade ? 'btn tp-submit' : `wallet-btn btn ${conn.address ? 'is-on' : 'btn-primary'} ${wrong ? 'is-wrong' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={trade ? undefined : conn.address ? `Wallet ${shortAddress(conn.address)}` : 'Connect wallet'}
        data-testid={trade ? undefined : 'wallet-button'}
        data-tour={trade ? undefined : 'wallet'}
      >
        {!trade && <IconWallet size={16} />}
        {trade ? TRADE_COPY.connect : conn.address ? (
          <>
            {!canVerify && <span className="num wallet-addr">{shortAddress(conn.address)}</span>}
            {wrong ? <IconAlert size={12} /> : verified ? <IconCheck size={12} /> : null}
          </>
        ) : (
          <span className="wallet-label">Connect wallet</span>
        )}
      </button>
      {open ? (
        <div className="menu wallet-menu" role="menu">
          {!conn.address ? (
            <>
              <div className="menu-head">
                <strong>Connect a wallet</strong>
                <span className="muted">Verify your wallet to use wallet pages. EKO never asks for your seed phrase or private key, and you sign every transaction yourself.</span>
              </div>
              {unique.length === 0 ? (
                <div className="menu-note">
                  <strong>No browser wallet detected</strong>
                  <span className="muted">Install an EVM wallet such as MetaMask, Rabby or OKX Wallet, then reload.</span>
                </div>
              ) : (
                unique.map((c) => (
                  <button
                    key={c.uid}
                    className="menu-row"
                    role="menuitem"
                    disabled={connect.isPending}
                    onClick={() => void connectWallet(c)}
                  >
                    {c.icon ? <img src={c.icon} alt="" width={18} height={18} style={{ borderRadius: 4 }} /> : <IconWallet size={16} />}
                    <span className="menu-main">
                      <strong>{c.name}</strong>
                    </span>
                    {connect.isPending && connect.variables?.connector === c ? <span className="spinner" /> : null}
                  </button>
                ))
              )}
            </>
          ) : (
            <>
              <div className="menu-head">
                <strong className="num">{shortAddress(conn.address)}</strong>
                <span className="muted">{conn.connector?.name}</span>
              </div>
              <div className="wallet-rows">
                <div>
                  <span className="muted">Network</span>
                  <span>{Object.values(NETWORKS).find((n) => n.chainId === chainId)?.name ?? `Chain ${chainId}`}</span>
                </div>
                <div>
                  <span className="muted">Verified</span>
                  <span className={verified ? 'up' : 'muted'}>{verified ? 'Yes' : 'Not yet'}</span>
                </div>
              </div>
              {wrong ? (
                <button className="menu-row warnrow" role="menuitem" onClick={() => void ensureChain(target!.chainId).catch((e) => setErr((e as Error).message))}>
                  <IconAlert size={14} /> Switch to {target!.name}
                </button>
              ) : null}
              {mismatch ? <div className="menu-err" role="alert">{mismatch}</div> : canVerify ? (
                <>
                  <button className="btn btn-primary wallet-menu-verify" role="menuitem" aria-disabled={!!pending} onClick={verify}>
                    <IconCheck size={14} /> {C.verify}
                  </button>
                  {verifyMessage && <div className="menu-err" role="status">{verifyMessage}</div>}
                </>
              ) : null}
              <button
                className="menu-row"
                role="menuitem"
                onClick={async () => {
                  disconnect.mutate({});
                  await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
                  await refreshSession();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </>
          )}
          {err ? <div className="menu-err">{err}</div> : null}
          <div className="menu-sep" />
          <button className="menu-row menu-link" role="menuitem" onClick={() => go('/settings')}>
            Settings
          </button>
        </div>
      ) : null}
    </div>
  );
}

