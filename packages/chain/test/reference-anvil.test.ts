import {it,expect} from 'vitest';
import {decodeFunctionData,encodeAbiParameters,type Hex} from 'viem';
import {AnvilReferenceConfirmation,SerializedMeteredForkLease} from '../src/simulation/anvil.js';
import {referenceRouterAbi,referenceTokenAbi} from '../src/simulation/v3.js';
import type {AnvilRpc} from '../src/simulation/types.js';
import {input,cursor,probeOutput} from './reference-fixtures.js';
import {runV3Fork,acquiredMatches} from '../src/simulation/fork-check-cli.js';

it('buys actual balances, waits, exactly approves, sells and subtracts receipt gas on each isolated EOA',async()=>{
  let native=0n,tokens=0n,allowance=0n,resetCount=0,delay=0;
  const calls:{method:string;params:readonly unknown[]}[]=[];
  const rpc:AnvilRpc={request:async r=>{
    calls.push(r);
    if(r.method==='eth_getBlockByNumber')return {hash:cursor.blockHash,timestamp:`0x${BigInt(cursor.timestampSec).toString(16)}`};
    if(r.method==='eth_chainId')return '0x1237';
    if(r.method==='eth_getCode')return '0x';
    if(r.method==='anvil_setCode')return null;
    if(r.method==='debug_traceCall'){expect(r.params[1]).toBe('latest');expect(r.params[2]).not.toHaveProperty('stateOverrides');return {output:probeOutput()};}
    if(r.method==='eth_getBalance')return `0x${native.toString(16)}`;
    if(r.method==='anvil_setBalance'){native=BigInt(r.params[1] as string);return null;}
    if(r.method==='eth_call'){
      const tx=r.params[0] as {to:string;data:Hex};
      if(tx.to===input.route.quoter)return encodeAbiParameters([{type:'uint256'}],[990n]);
      const decoded=decodeFunctionData({abi:referenceTokenAbi,data:tx.data});
      return encodeAbiParameters([{type:'uint256'}],[decoded.functionName==='balanceOf'?tokens:allowance]);
    }
    if(r.method==='eth_sendTransaction'){
      const tx=r.params[0] as {to:string;data:Hex;value:Hex};
      if(tx.to===input.route.coin){const d=decodeFunctionData({abi:referenceTokenAbi,data:tx.data});if(d.functionName!=='approve')throw new Error('Unexpected');allowance=d.args[1];}
      else {const d=decodeFunctionData({abi:referenceRouterAbi,data:tx.data});if(d.functionName==='exactInputSingle'){native-=1000n;tokens=900n;}else if(d.functionName==='multicall'){expect(allowance).toBe(tokens);tokens=0n;native+=990n;}}
      native-=2n;
      return `0x${'ab'.repeat(32)}`;
    }
    if(r.method==='eth_getTransactionByHash')return {blockNumber:'0x1'};
    if(r.method==='eth_getTransactionReceipt')return {status:'0x1',gasUsed:'0x1',effectiveGasPrice:'0x2'};
    if(r.method==='debug_traceTransaction')return {output:'0x'};
    if(r.method==='evm_increaseTime'){delay=Number(r.params[0]);return delay;}
    if(['evm_mine','anvil_impersonateAccount','anvil_stopImpersonatingAccount'].includes(r.method))return null;
    throw new Error('Unexpected local RPC');
  }};
  const lease=new SerializedMeteredForkLease(rpc,async()=>{resetCount++;native=0n;tokens=0n;allowance=0n;});
  const results=await new AnvilReferenceConfirmation(lease).confirm(input,1000n);
  expect(resetCount).toBe(2);expect(delay).toBe(3);expect(results.map(r=>r.spent)).toEqual(['1000','1000']);
  expect(results.map(r=>r.returned)).toEqual(['990','990']);expect(results[0].account).not.toBe(results[1].account);
  expect(results.every(r=>r.tokens==='900' && r.validSellState && r.allowanceBefore==='0')).toBe(true);
  expect(calls.filter(r=>/setCode|setStorage|stateOverride/.test(r.method))).toEqual([]);
  resetCount=0;calls.length=0;
  const fork=await runV3Fork(lease,input);
  expect(fork.probe).not.toBeNull();expect(fork.deep).toHaveLength(2);expect(resetCount).toBe(3);
  expect(calls.filter(r=>r.method==='anvil_setCode')).toHaveLength(1);
  expect(calls.filter(r=>/setStorage/.test(r.method))).toEqual([]);
  expect(acquiredMatches(fork)).toEqual([]);
  const expected=input.matches.slice(0,1).map(e=>({...e,caseId:`${fork.coin}:${cursor.blockHash}:${fork.routeId}:eoa`}));
  const acquired=acquiredMatches(fork,expected);expect(acquired).toHaveLength(2);
  expect(new Set(acquired.map(m=>m.caseId)).size).toBe(1);expect(acquired[0].actualSpent).toBe('1000');
});
it('serializes leases shared by different callers and releases after failure',async()=>{
  const rpc:AnvilRpc={request:async()=>null},reset=async()=>{},a=new SerializedMeteredForkLease(rpc,reset),b=new SerializedMeteredForkLease(rpc,reset);
  const sequence:number[]=[];
  const first=a.withExclusive(async()=>{sequence.push(1);await new Promise(resolve=>setTimeout(resolve,5));sequence.push(2);throw new Error('fixture failure');}).catch(()=>{});
  const second=b.withExclusive(async()=>{sequence.push(3);});await Promise.all([first,second]);expect(sequence).toEqual([1,2,3]);
});
