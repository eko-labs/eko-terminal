import { lazy, Suspense } from 'react';
import { requestWallet, useWalletState } from '../lib/walletState';
import { TRADE_COPY } from '../copy/trade';
import { IconWallet } from './icons';
const ConnectedButton = lazy(() => import('../WalletRuntime').then(m => ({ default: m.WalletControls })));
export function WalletButton({ trade = false }: { trade?: boolean }) {
  const ready = useWalletState(s => s.ready);
  const button = trade ? <button className="btn tp-submit" disabled>{TRADE_COPY.connect}</button>
    : <button className="wallet-btn btn btn-primary" onClick={requestWallet} aria-label="Connect wallet" data-testid="wallet-button" data-tour="wallet"><IconWallet size={16} /><span className="wallet-label">Connect wallet</span></button>;
  return ready ? <Suspense fallback={button}><ConnectedButton trade={trade} /></Suspense> : button;
}
