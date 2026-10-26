import { useCallback, useRef, useState } from 'react';
import { navigate, usePath } from '../lib/router';
import { useMedia } from '../lib/useMedia';
import { useApp } from '../store/app';
import { useOnboarding } from '../store/onboarding';
import { Lockup } from './brand';
import { useOutside } from './hooks';
import { IconClose, IconMenu } from './icons';
import { WalletButton } from './WalletSlot';
export { WalletButton } from './WalletSlot';

export const NAV = [
  { path: '/trade', label: 'Trade' },
  { path: '/settings', label: 'Settings' },
];

/** Request a trading mode. Live always goes through the Live setup guide, which switches when you're ready. */
export function requestMode(m: 'paper' | 'live') {
  if (m === 'live') {
    if (useApp.getState().mode !== 'live') useOnboarding.getState().requestLiveMode();
    return;
  }
  useApp.getState().setMode('paper');
}

/** Phones: the pages and Help live behind one menu button. */
function MobileNav() {
  const path = usePath();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutside(ref, close, open);
  const go = (p: string) => {
    setOpen(false);
    navigate(p);
  };
  return (
    <div className="hdr-mnav" ref={ref}>
      <button className="hdr-icon" onClick={() => setOpen(!open)} aria-label="Menu" aria-expanded={open} aria-haspopup="menu" data-tour="help">
        {open ? <IconClose size={18} /> : <IconMenu size={18} />}
      </button>
      {open ? (
        <nav className="menu hdr-mnav-menu" role="menu" aria-label="Primary">
          {[...NAV, { path: '/settings', label: 'Settings' }].map((n) => (
            <button key={n.path} role="menuitem" className="menu-row menu-link" aria-current={path.startsWith(n.path) ? 'page' : undefined} onClick={() => go(n.path)}>
              {n.label}
            </button>
          ))}
          <div className="menu-sep" />
          <button
            role="menuitem"
            className="menu-row menu-link"
            onClick={() => {
              setOpen(false);
              useOnboarding.getState().openHelp();
            }}
          >
            Help
          </button>
        </nav>
      ) : null}
    </div>
  );
}

function HelpButton() {
  return (
    <button className="hdr-help" onClick={() => useOnboarding.getState().openHelp()} aria-label="Help" data-tip="Help" data-tour="help">
      ?
    </button>
  );
}

/** Logo, the three pages, and on the right: Paper/Live, Help and the wallet. On phones: logo, Paper/Live, wallet and a menu. */
export function Header() {
  const path = usePath();
  const isMobile = useMedia('(max-width: 900px)');
  return (
    <header className="hdr">
      <button className="hdr-logo" onClick={() => navigate('/')} aria-label="EKO home page">
        <Lockup height={isMobile ? 24 : 32} />
      </button>
      {!isMobile ? (
        <nav className="hdr-nav" aria-label="Primary">
          {NAV.map((n) => {
            const active = path.startsWith(n.path);
            return (
              <button key={n.path} className="hdr-nav-item" aria-current={active ? 'page' : undefined} onClick={() => navigate(n.path)}>
                {n.label}
              </button>
            );
          })}
        </nav>
      ) : null}
      <span className="grow" />
      {!isMobile ? <HelpButton /> : null}
      <span className="hdr-div" aria-hidden />
      <WalletButton />
      {isMobile ? <MobileNav /> : null}
    </header>
  );
}
