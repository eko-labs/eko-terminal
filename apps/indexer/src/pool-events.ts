import { decodeResult, eventSelector, v3Abi, type ChainEvent } from '@eko/chain';
import { decodeEventLog } from 'viem';
const poolCreatedTopic=eventSelector(v3Abi[0]);
/** Third-party PoolCreated facts are retained, with creation_verified=false at storage. */
export function decodePoolEvents(log:Parameters<typeof decodeResult>[0],ctx:Parameters<typeof decodeResult>[1]) {
  const result=decodeResult(log,ctx);
  if(result.events.length||log.topics[0]!==poolCreatedTopic)return result;
  try {const event=decodeEventLog({abi:[v3Abi[0]],topics:log.topics,data:log.data,strict:true});return {events:[{...event,source:'uniswap_v3',address:log.address} as ChainEvent],unknownTopics:0,malformedLogs:0};}
  catch {return {events:[] as ChainEvent[],unknownTopics:0,malformedLogs:1};}
}
