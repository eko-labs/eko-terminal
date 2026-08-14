import { getAddress, type Address, type Hex, type Transaction } from 'viem';
export type ActorTransaction = Pick<Transaction, 'from' | 'to'>;
export interface ActorContext {
  /** Sender of the UserOp enclosing this log, resolved by the caller from receipt boundaries. */
  userOpSender?: Address;
  toCode?: Hex;
}
export function resolveActor(tx: ActorTransaction, ctx: ActorContext = {}): Address {
  if (ctx.userOpSender) return getAddress(ctx.userOpSender);
  if (tx.to && tx.to.toLowerCase() !== tx.from.toLowerCase() && /^0xef0100[0-9a-fA-F]{40}$/.test(ctx.toCode ?? '')) return getAddress(tx.to);
  return getAddress(tx.from);
}
