import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnect, useConnection, useConnectors, useDisconnect } from 'wagmi';
import { NETWORKS, NETWORK_FOR_MODE, shortAddress } from '@eko/shared';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { ensureChain, isUserRejection, siweSignIn } from '../lib/trade';
import { useApp } from '../store/app';
import { useWalletState } from '../lib/walletState';
import { useOutside } from './hooks';
import { IconAlert, IconCheck, IconWallet } from './icons';
import { CHAIN_ID } from '@eko/shared';

export function WalletButton() {
  const conn = useConnection();
  const chainId = conn.chainId;
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const account = useApp((s) => s.account);
  const mode = useApp((s) => s.mode);
  const refreshSession = useApp((s) => s.refreshSession);
  const toast = useApp((s) => s.toast);
  const [open, setOpen] = useState(useWalletState.getState().open);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutside(ref, close, open);
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener('eko:open-wallet', h);
    return () => window.removeEventListener('eko:open-wallet', h);
  }, []);
  const target = mode === 'paper' ? null : NETWORKS[NETWORK_FOR_MODE[mode]];
  const wrong = !!conn.address && !!target && chainId !== target.chainId;
  const verified = !!conn.address && account?.kind === 'wallet' && account.walletAddress === conn.address.toLowerCase();
  const unique = useMemo(() => {
    const seen = new Set<string>();
    return connectors.filter((c) => {
      const k = c.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [connectors]);

  const verify = async () => {
    setErr(null);
    try {
      await siweSignIn(target?.chainId ?? chainId ?? CHAIN_ID);
      await refreshSession();
      toast({ kind: 'ok', title: 'Wallet verified', body: 'Signed in with Ethereum (EIP-4361).' });
    } catch (e) {
      setErr(isUserRejection(e) ? 'Signature rejected.' : (e as Error).message);
    }
  };
  const go = (p: string) => {
    setOpen(false);
    navigate(p);
  };

  return (
    <div className="wallet" ref={ref}>
      <button
        className={`wallet-btn btn ${conn.address ? 'is-on' : 'btn-primary'} ${wrong ? 'is-wrong' : ''}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={conn.address ? `Wallet ${shortAddress(conn.address)}` : 'Connect wallet'}
        data-testid="wallet-button"
        data-tour="wallet"
      >
        <IconWallet size={16} />
        {conn.address ? (
          <>
            <span className="num wallet-addr">{shortAddress(conn.address)}</span>
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
                    onClick={() => {
                      setErr(null);
                      connect.mutate({ connector: c }, { onError: (e) => setErr(isUserRejection(e) ? 'Connection rejected.' : e.message), onSuccess: () => setOpen(true) });
                    }}
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
              {!verified ? (
                <button className="menu-row" role="menuitem" onClick={() => void verify()}>
                  <IconCheck size={14} /> Verify wallet · sign a message, no transaction
                </button>
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

