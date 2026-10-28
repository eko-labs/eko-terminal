import { api } from './api';

const PENDING_KEY = 'eko.pendingTx';

export function rememberPending(orderId: string, txHash: string) {
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}');
    all[orderId] = { txHash, at: Date.now() };
    localStorage.setItem(PENDING_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}
export function forgetPending(orderId: string) {
  try {
    const all = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}');
    delete all[orderId];
    localStorage.setItem(PENDING_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** After a reload/reconnect: report any tx hash the wallet returned but the server never received. */
async function flush() {
  let all: Record<string, { txHash: string; at: number }> = {};
  try {
    all = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}');
  } catch {
    return;
  }
  for (const [orderId, v] of Object.entries(all)) {
    try {
      await api(`/api/orders/${orderId}/submitted`, { body: { txHash: v.txHash }, background: true });
      forgetPending(orderId);
    } catch (err) {
      if (Date.now() - v.at > 24 * 3600_000) forgetPending(orderId);
      void err;
    }
  }
}


let flight: Promise<void> | undefined;
export function flushPendingReports() {
  return flight ?? (flight = flush().finally(() => { flight = undefined; }));
}
