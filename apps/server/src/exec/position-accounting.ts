export interface SpotAccounting { quantity: number; costBasis: number; realizedPnl: number }

/** Heritage average-cost accounting, shared by terminal fills and Swarm paper fills. */
export function accountSpotFill(current: SpotAccounting, side: 'buy' | 'sell', baseQty: number, quoteQty: number, fee: number): SpotAccounting {
  let { quantity, costBasis, realizedPnl } = current;
  if (side === 'buy') {
    quantity += baseQty;
    costBasis += quoteQty + fee;
  } else {
    // Only the share backed by recorded buys has a known basis. External assets never become booked profit.
    const sold = Math.min(baseQty, quantity);
    const avg = quantity > 0 ? costBasis / quantity : 0;
    const share = baseQty > 0 ? sold / baseQty : 0;
    realizedPnl += (quoteQty - fee) * share - avg * sold;
    costBasis -= avg * sold;
    quantity -= sold;
    if (quantity < 1e-12) { quantity = 0; costBasis = 0; }
  }
  return { quantity, costBasis, realizedPnl };
}
