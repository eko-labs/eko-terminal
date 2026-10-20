import type { Feed } from './types.js';
/** Legacy market streams are inactive when /v1 reads the indexed chain tables. */
export const storedFeed:Feed={
  source:'indexed',simulated:false,start:async()=>{},stop:()=>{},history:async()=>[],
  health:()=>({source:'indexed',simulated:false,status:'stale',lastMessageAt:null,lagMs:null,reconnects:0}),
};
