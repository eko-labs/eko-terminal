// Offline fixture generator: pnpm --filter @eko/chain exec node --import tsx test/generate-pons-evm-cases.ts
import { readFileSync } from 'node:fs';
import { ponsLocalRoundTrip } from '../src/simulation/pons-math.js';
const state={tokens:1000000n,realQuote:100000n,virtualQuote:100000n,reservedTokens:500000n};
for(const size of [1000n,10000n]) {
 const returns=Array.from({length:30},(_,i)=>{
  const terms=[{kind:'ordinary' as const,base:'gross' as const,bps:BigInt(25+i*7),fixedWei:0n},{kind:'creator' as const,base:'gross' as const,bps:BigInt(50+i*11),fixedWei:0n}];
  const r=ponsLocalRoundTrip(state,size,terms,terms);if(!r.sell.capacity)throw new Error('Fixture capacity');return r.sell.returned.toString();
 });
 const literal=`[uint256(${returns[0]}),${returns.slice(1).join(',')}];`;
 if(process.argv.includes('--check')) {
  if(!readFileSync(new URL('../probe/test/PonsCurve.t.sol',import.meta.url),'utf8').includes(literal))throw new Error('EVM expected cases are stale');
 } else console.log(`${size}: ${literal}`);
}
