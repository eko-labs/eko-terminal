import { describe, expect, it } from 'vitest';
import { loadRegistry, entryPoint07Abi, userOperationEventAbi } from '@eko/chain';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, toHex, type AbiEvent, type Address, type Hex } from 'viem';
import { receiptActors } from '../src/receipt-actors.js';
import { collectWalletProtocol } from '../src/wallet-protocol.js';
import type { RpcBlock, RpcLog, RpcReceipt, RpcTransaction } from '../src/types.js';
const address=(n:number):Address=>`0x${n.toString(16).padStart(40,'0')}`;
const hash=(n:number):Hex=>`0x${n.toString(16).padStart(64,'0')}`;
const registry=loadRegistry(), before=parseAbi(['event BeforeExecution()'])[0], transfer=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])[0];
function fixture(version:'v06'|'v07'|'v08'='v08',count=1,paymaster=address(0)) {
  const tx:RpcTransaction={hash:hash(2),from:address(10),to:registry.requireAddress(`entryPoints.${version}`)};
  const block:RpcBlock={number:'0x1',timestamp:'0x64',hash:hash(1),parentHash:hash(0),transactions:[tx]};
  const log=(event:AbiEvent,emitter:Address,args:Record<string,unknown>,index:number):RpcLog=>({address:emitter,
    topics:encodeEventTopics({abi:[event],args}) as [Hex,...Hex[]],data:encodeAbiParameters(event.inputs.filter(p=>!p.indexed),event.inputs.filter(p=>!p.indexed).map(p=>args[p.name!])),
    blockNumber:block.number,blockHash:block.hash,transactionHash:tx.hash,logIndex:toHex(index)});
  const logs=[log(before,tx.to!,{},0)];
  for(let i=0;i<count;i++)logs.push(log(transfer,address(30),{from:address(0),to:address(20+i),value:100n},i*2+1),
    log(userOperationEventAbi[0],tx.to!,{userOpHash:hash(20+i),sender:address(20+i),paymaster,nonce:BigInt(i),success:true,actualGasCost:1n,actualGasUsed:2n},i*2+2));
  const receipt:RpcReceipt={transactionHash:tx.hash,blockNumber:block.number,blockHash:block.hash,status:'0x1',from:tx.from,to:tx.to,logs};
  return {tx,block,receipt,log};
}
describe('receipt holder attribution (zero acquisition)',()=>{
  it.each(['v06','v07','v08'] as const)('attributes one operation on registry %s',version=>{
    const f=fixture(version);expect(receiptActors(f.tx,f.receipt,registry).actors.get('1')).toEqual({sender:address(20),accountClass:'erc4337',operationHash:hash(20),bundler:address(10),paymaster:null});
  });
  it('brackets two operations and retains a sponsor independently of the trader and 043',async()=>{
    const f=fixture('v08',2,address(40)),result=await collectWalletProtocol(f.block,[f.receipt],registry,{codes:new Map(),metadata:new Map(),pools:new Map(),rate:null});
    expect(result.actors.get(`${f.tx.hash}:1`)).toMatchObject({userOpSender:address(20),accountClass:'erc4337'});
    expect(result.actors.get(`${f.tx.hash}:3`)).toMatchObject({userOpSender:address(21),accountClass:'erc4337'});
    const coverage=JSON.parse(result.rows.get('wallet_protocol_coverage')[0].data as string);
    expect(coverage.principalBindings).toBe('missing_043');expect(coverage.bindings).toEqual([]);
    expect(coverage.holderAttribution.bindings.map((b:{sender:string;paymaster:string;bundler:string})=>[b.sender,b.paymaster,b.bundler])).toEqual([[address(20),address(40),address(10)],[address(21),address(40),address(10)]]);
    expect(result.rows.get('userops')).toHaveLength(2);
  });
  it('rejects mismatched input counts, absent boundaries, nested and unknown EntryPoints',()=>{
    const f=fixture('v07',2);
    const op={sender:address(20),nonce:0n,initCode:'0x' as Hex,callData:'0x' as Hex,accountGasLimits:hash(0),preVerificationGas:0n,gasFees:hash(0),paymasterAndData:'0x' as Hex,signature:'0x' as Hex};
    f.tx.input=encodeFunctionData({abi:entryPoint07Abi,functionName:'handleOps',args:[[op],address(10)]});
    expect(receiptActors(f.tx,f.receipt,registry)).toMatchObject({actors:new Map(),reason:'user_operation_event_count_mismatch'});
    delete f.tx.input;f.receipt.logs.shift();expect(receiptActors(f.tx,f.receipt,registry).reason).toBe('before_execution_count_mismatch');
    f.receipt.logs.unshift(f.log(before,f.tx.to!,{},0),f.log(before,f.tx.to!,{},5));expect(receiptActors(f.tx,f.receipt,registry).reason).toBe('before_execution_count_mismatch');
    f.receipt.logs[1].address=address(99);expect(receiptActors(f.tx,f.receipt,registry).reason).toBe('nested_or_unknown_entry_point');
    f.tx.to=address(99);expect(receiptActors(f.tx,f.receipt,registry).reason).toBe('unverified_entry_point');
  });
  it('does not attribute validation, after-bundle, failed-op, synthetic or malformed logs',()=>{
    const f=fixture();f.receipt.logs.push(f.log(transfer,address(30),{from:address(20),to:address(10),value:1n},3));
    expect([...receiptActors(f.tx,f.receipt,registry).actors.keys()]).toEqual(['1']);
    f.receipt.synthetic=true;expect(receiptActors(f.tx,f.receipt,registry).reason).toBe('missing_complete_receipt');delete f.receipt.synthetic;
    f.receipt.logs[2].data='0x';expect(receiptActors(f.tx,f.receipt,registry).actors.size).toBe(0);
  });
});
