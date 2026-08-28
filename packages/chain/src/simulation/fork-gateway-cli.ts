import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { GuardCursorSchema } from '@eko/shared';
import { createMeteredClients } from '../rpc/clients.js';
import { rpcConfig } from '../rpc/metered.js';
import { MeteredForkGateway, listenForkGateway } from './fork-gateway.js';

export async function runGateway(pinPath:string) {
  const env=process.env;
  if(!env.RPC_HTTP_URL||!env.RPC_SESSION_BUDGET||!Number.isFinite(rpcConfig(env).sessionBudget))throw new Error('Paid RPC and finite session budget required');
  const cursor=GuardCursorSchema.parse(JSON.parse(await readFile(pinPath,'utf8')));
  const clients=createMeteredClients(env,{standalone:true,onSessionBudget:()=>{}});
  let listener:Awaited<ReturnType<typeof listenForkGateway>>|undefined;
  try {
    const gateway=new MeteredForkGateway({request:r=>clients.forkArchive.request(r as never)},clients.meter,env.EKO_FORK_CACHE_DIR??'.data/fork-cache',Number(env.EKO_FORK_CACHE_BYTES??64*1024*1024));
    await gateway.setPin(cursor);listener=await listenForkGateway(gateway,Number(env.EKO_FORK_GATEWAY_PORT??9545));
    console.log(JSON.stringify({event:'fork_gateway_ready',blockNumber:cursor.blockNumber}));
    await new Promise<void>(resolve=>{
      const done=()=>{process.removeListener('SIGINT',done);process.removeListener('SIGTERM',done);resolve();};
      process.once('SIGINT',done);process.once('SIGTERM',done);
    });
    console.log(JSON.stringify({event:'fork_gateway_final',...gateway.snapshot()}));
  } finally {try{await listener?.close();}finally{await clients.meter.close();}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [pin]=process.argv.slice(2);if(!pin)throw new Error('Usage: fork:gateway pin.json');
  runGateway(pin).catch(()=>{console.error('Fork gateway unavailable');process.exitCode=1;});
}
