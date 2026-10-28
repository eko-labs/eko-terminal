import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { getConnection, sendTransaction } from 'wagmi/actions';
import { useConnection } from 'wagmi';
import type { Address, Hex } from 'viem';
import type { TradeOrder } from '@eko/shared';
import { TradeProvider, type TradeAdapter } from './TradeContext';
import { GuardedTradeFlow, TradeFlowError } from '../../lib/tradeFlow';
import { guardedTradeClient, guardedOrderHistory } from '../../lib/guardedTradeClient';
import { approveExactPermit2, approveExactToken } from '../../lib/trade';
import { wagmiConfig, walletChainId } from '../../lib/wallet';
import { serverNow } from '../../lib/clock';
import { useOnboarding } from '../../store/onboarding';
import { useShell } from '../../store/shell';
import { track } from '../../lib/telemetry';
import { TRADE_COPY as C } from '../../copy/trade';
import { CHAIN_ID } from '@eko/shared';

function current() {
  const connection = getConnection(wagmiConfig), shell = useShell.getState();
  return { wallet: connection.address ? { address: connection.address, chainId: connection.chainId } : null,
    accountId: shell.me?.account.id ?? null, verifiedWallet: shell.me?.account.wallet ?? null, config: shell.config };
}
export function WalletTradeProvider({ children }: { children: ReactNode }) {
  const connection = useConnection(), me = useShell(s => s.me), realtime = useShell(s => s.realtime), wsState = useShell(s => s.wsState);
  const identity = `${me?.account.id ?? ''}:${me?.account.wallet ?? ''}:${connection.address ?? ''}:${connection.chainId ?? ''}`;
  const [feedback, setFeedback] = useState<{ identity: string; message: string; order?: TradeOrder } | null>(null);
  const flow = useMemo(() => new GuardedTradeFlow({
    current, client: guardedTradeClient, storage: localStorage, now: serverNow,
    approve: (step, account, check) => step.kind === 'permit2'
      ? approveExactPermit2(step, current().config?.trading.permit2 ?? '', CHAIN_ID, account, check)
      : approveExactToken(step, CHAIN_ID, account, check),
    send: async (tx, account, check) => {
      check();
      return sendTransaction(wagmiConfig, { account: account as Address, to: tx.to as Address, data: tx.data as Hex, value: BigInt(tx.value), chainId: walletChainId(CHAIN_ID) });
    },
    onPhase: (_phase, message) => { if (identity === liveIdentity()) setFeedback({ identity, message }); },
    onOrder: order => { if (identity === liveIdentity()) { setFeedback({ identity, order, message: C.statuses[order.status] }); if (order.status === 'confirmed' && useOnboarding.getState().owner === me?.account.id) useOnboarding.getState().markStep('guarded_trade'); } },
    mismatch: () => track('ui.trade.calldata_mismatch', 1),
  }), [identity]);
  function liveIdentity() {
    const c = getConnection(wagmiConfig), m = useShell.getState().me;
    return `${m?.account.id ?? ''}:${m?.account.wallet ?? ''}:${c.address ?? ''}:${c.chainId ?? ''}`;
  }
  useEffect(() => {
    let active = true;
    const recover = () => flow.recover().catch(error => {
      if (active && error instanceof TradeFlowError && identity === liveIdentity()) setFeedback({ identity, message: error.message });
    });
    if (connection.chainId === CHAIN_ID && me?.account.wallet?.toLowerCase() === connection.address?.toLowerCase()) void recover();
    return () => { active = false; flow.clear(); };
  }, [flow, wsState]);
  useEffect(() => {
    if (!realtime || !me?.account.wallet || connection.chainId !== CHAIN_ID || me.account.wallet.toLowerCase() !== connection.address?.toLowerCase()) return;
    const receive = (order: TradeOrder) => {
      if (identity !== liveIdentity()) return;
      try { flow.reconcile(order); }
      catch (error) { if (error instanceof TradeFlowError) { track('ui.trade.calldata_mismatch', 1); setFeedback({ identity, message: error.message }); } }
    };
    return realtime.subscribe('orders', event => { receive(event.data); }, async () => {
      const { rows } = await guardedOrderHistory(); rows.forEach(receive); await flow.recover();
    });
  }, [realtime, flow, identity]);
  const adapter: TradeAdapter = {
    wallet: connection.address ? { address: connection.address, chainId: connection.chainId } : null,
    identity, feedback: feedback?.identity === identity ? feedback : undefined,
    execute: h => flow.execute(h),
  };
  return <TradeProvider adapter={adapter}>{children}</TradeProvider>;
}
