import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { WALLET_COPY as C } from '../../copy/wallet';
import type { TradeAdapter } from './TradeContext';
import { claimTradeVerifyHint } from './tradeVerifyHint';

export function TradeWalletVerification({ verification, fromTradeConnect }: {
  verification: NonNullable<TradeAdapter['verification']>;
  fromTradeConnect: boolean;
}) {
  const [showHint, setShowHint] = useState(false);
  const hintId = useId();
  const verifyButton = useRef<HTMLButtonElement>(null);
  const hint = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (fromTradeConnect && claimTradeVerifyHint()) setShowHint(true);
  }, [fromTradeConnect]);
  const dismiss = useCallback(() => {
    if (hint.current?.contains(document.activeElement)) verifyButton.current?.focus();
    setShowHint(false);
  }, []);
  useEffect(() => {
    if (!showHint) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dismiss, showHint]);

  return <div className="tp-verification">
    <button ref={verifyButton} type="button" className="btn btn-primary tp-submit" aria-disabled={verification.pending}
      aria-describedby={showHint ? hintId : undefined} onClick={verification.verify}>{C.verify}</button>
    {showHint && <div className="tp-verify-hint" ref={hint}>
      <p id={hintId} role="status">{C.signature}</p>
      <button type="button" className="btn btn-sm" aria-label={C.dismissHint} aria-describedby={hintId} onClick={dismiss}>×</button>
    </div>}
    {verification.message && <p className="note" role="status">{verification.message}</p>}
  </div>;
}
