import { decodeAbiParameters, encodeFunctionData, keccak256, stringToHex, toHex, type Address, type Hex } from 'viem';
import { referenceTokenAbi, v3Legs } from './v3.js';
import type { AnvilRpc, DeepEvidence, MeteredForkLease, ReferenceInput } from './types.js';
const quantity = (value: unknown) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('Invalid fork quantity');
  return BigInt(value);
};
const bytes = (value: unknown): Hex => {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new Error('Invalid fork bytes');
  return value as Hex;
};
/**
 * Sends a local fork transaction and waits for Anvil to mine it. On a cold fork, mining loads state through the
 * metered gateway, so the receipt is not ready when eth_sendTransaction returns. Polling the transaction by hash stays
 * local (a pending transaction is found in Anvil's pool); polling the receipt would be forwarded upstream and paid.
 * Arbitrum-style chains pay no priority fee, so local transactions carry none.
 */
export async function sendAndMine(rpc: AnvilRpc, tx: Record<string, unknown>, timeoutMs = 60_000) {
  const hash = bytes(await rpc.request({ method: 'eth_sendTransaction', params: [{ ...tx, maxPriorityFeePerGas: '0x0' }] }));
  for (const started = Date.now(); ; await new Promise(resolve => setTimeout(resolve, 100))) {
    const mined = await rpc.request({ method: 'eth_getTransactionByHash', params: [hash] }) as { blockNumber?: unknown } | null;
    if (mined?.blockNumber) break;
    if (Date.now() - started > timeoutMs) throw new Error('Fork transaction not mined');
  }
  const receipt = await rpc.request({ method: 'eth_getTransactionReceipt', params: [hash] });
  if (!receipt) throw new Error('Missing fork receipt');
  return { hash, receipt };
}
export class AnvilReferenceConfirmation {
  constructor(private readonly lease: MeteredForkLease) {}
  async confirm(input: ReferenceInput, quotedBuy: bigint): Promise<DeepEvidence[]> {
    return this.lease.withExclusive(async (rpc, reset) => {
      const out: DeepEvidence[] = [];
      for (const index of [0,1]) {
        await reset(input.cursor);
        const block = await rpc.request({ method: 'eth_getBlockByNumber', params: [toHex(BigInt(input.cursor.blockNumber)), false] }) as { hash?: string };
        if (block?.hash?.toLowerCase() !== input.cursor.blockHash.toLowerCase()) throw new Error('Fork pin mismatch');
        if (quantity(await rpc.request({method:'eth_chainId',params:[]})) !== BigInt(input.cursor.chainId)) throw new Error('Fork chain mismatch');
        const account = `0x${keccak256(stringToHex(`eko-reference:${input.cursor.blockHash}:${input.route.id}:${input.sizeUsd}:${index}`)).slice(-40)}` as Address;
        if (bytes(await rpc.request({method:'eth_getCode',params:[account,'latest']})) !== '0x') throw new Error('Reference identity is not an EOA');
        const trace: unknown[] = [];
        const call = async (to: Address, data: Hex) => bytes(await rpc.request({ method:'eth_call',params:[{from:account,to,data},'latest'] }));
        const read = async (name:'balanceOf'|'allowance') => decodeAbiParameters([{type:'uint256'}],await call(input.route.coin,encodeFunctionData({abi:referenceTokenAbi,functionName:name,args:name==='balanceOf'?[account]:[account,input.route.router]})))[0];
        const allowanceBefore = await read('allowance');
        if (allowanceBefore !== 0n || await read('balanceOf') !== 0n) throw new Error('Reference identity is not fresh');
        const balance = async () => quantity(await rpc.request({ method:'eth_getBalance',params:[account,'latest'] }));
        // Only native gas/entry funding is overridden. Purchase, restrictions and allowance storage remain real.
        await rpc.request({method:'anvil_setBalance',params:[account,toHex(input.sizeWei+10n**18n)]});
        await rpc.request({method:'anvil_impersonateAccount',params:[account]});
        const send = async (to:Address,data:Hex,value=0n) => {
          const mined = await sendAndMine(rpc, {from:account,to,data,value:toHex(value),gas:toHex(30_000_000n)});
          const hash = mined.hash, receipt = mined.receipt as {status:unknown;gasUsed:unknown;effectiveGasPrice:unknown};
          const frame = await rpc.request({method:'debug_traceTransaction',params:[hash,{tracer:'callTracer',tracerConfig:{withLog:true}}]});
          trace.push({hash,receipt,frame});
          const ok=quantity(receipt.status)===1n;
          return {ok,gas:quantity(receipt.gasUsed)*quantity(receipt.effectiveGasPrice),revert:ok?'0x' as Hex:bytes((frame as {output?:unknown}).output ?? '0x')};
        };
        try {
          const legs=v3Legs(input.route,account,input.sizeWei), initial=await balance();
          const buy=await send(legs.buy.target,legs.buy.data,legs.buy.value);
          const afterBuy=await balance(), tokens=await read('balanceOf');
          let quotedSell=0n,returned=0n,sellOk=false,validSellState=false;
          let revert:Hex=buy.revert;
          // Always perform the ordinary 3-second confirmation. Longer verified cooldown is recorded explicitly.
          const delaySec=Math.max(3,input.route.cooldown?.seconds ?? 3);
          if (!Number.isSafeInteger(delaySec) || delaySec > 3600) throw new Error('Unsupported cooldown');
          if (buy.ok && tokens>0n) {
            await rpc.request({method:'evm_increaseTime',params:[delaySec]});
            await rpc.request({method:'evm_mine',params:[]});
            const approval=await send(input.route.coin,encodeFunctionData({abi:referenceTokenAbi,functionName:'approve',args:[input.route.router,tokens]}));
            if (approval.ok && await read('allowance')===tokens) {
              const q=await call(legs.quoteSell.target,`0x${legs.quoteSell.data.slice(2,2+Number(legs.quoteSell.amountOffset)*2)}${toHex(tokens,{size:32}).slice(2)}${legs.quoteSell.data.slice(2+(Number(legs.quoteSell.amountOffset)+32)*2)}`);
              quotedSell=decodeAbiParameters([{type:'uint256'}],q.slice(0,66) as Hex)[0];
              validSellState=quotedSell>0n && input.route.cooldown!==null && input.route.cooldown.evidenceIds.length>0;
              const beforeSell=await balance(), sell=await send(input.route.router,legs.sellWithAmount(tokens));
              returned=sell.ok ? await balance()-beforeSell+sell.gas : 0n;
              sellOk=sell.ok;revert=sell.revert;
            } else revert=approval.revert;
          }
          out.push({account,blockHash:input.cursor.blockHash as Hex,allowanceBefore:allowanceBefore.toString(),delaySec,
            tokens:tokens.toString(),spent:(buy.ok?initial-afterBuy-buy.gas:0n).toString(),returned:returned.toString(),
            quotedBuy:quotedBuy.toString(),quotedSell:quotedSell.toString(),buyOk:buy.ok,sellOk,revert,validSellState,trace});
        } finally { await rpc.request({method:'anvil_stopImpersonatingAccount',params:[account]}); }
      }
      return out;
    });
  }
}

const forkLocks=new WeakMap<AnvilRpc,Promise<void>>();
/** Shared per-client lock also serializes different lease objects on the same Anvil host. */
// The local gateway owns pinning and paid-only archive metering, including lazy loads.
export class SerializedMeteredForkLease implements MeteredForkLease {
  constructor(private readonly rpc:AnvilRpc,private readonly resetThroughMeteredGateway:(cursor:import('@eko/shared').GuardCursor)=>Promise<void>) {}
  async withExclusive<T>(work:(rpc:AnvilRpc,reset:(cursor:import('@eko/shared').GuardCursor)=>Promise<void>)=>Promise<T>):Promise<T> {
    const previous=forkLocks.get(this.rpc) ?? Promise.resolve();
    let release!:()=>void;
    const next=new Promise<void>(resolve=>{release=resolve;});forkLocks.set(this.rpc,next);
    await previous;
    try {return await work(this.rpc,this.resetThroughMeteredGateway);} finally {release();if(forkLocks.get(this.rpc)===next)forkLocks.delete(this.rpc);}
  }
}
