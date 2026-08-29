/** Lead-only owned, metered fork driver; importing it opens no sockets or provider connection. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runForkCheckManifest, type ForkCheckManifest } from './fork-check-cli.js';

/** Retains the task 040 single-curve manifest (including held positions); now owns the gateway and Anvil. */
export async function runPonsForkManifest(manifestPath:string,outputPath:string) {
  const m=JSON.parse(await readFile(manifestPath,'utf8')) as Omit<ForkCheckManifest,'coins'> & Extract<ForkCheckManifest['coins'][number],{kind:'pons'}>;
  return runForkCheckManifest({cursor:m.cursor,ethUsd:m.ethUsd,coins:[{kind:'pons',route:m.route,matches:m.matches,delaySec:m.delaySec,held:m.held}]},outputPath);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [manifest,output]=process.argv.slice(2);
  if(!manifest||!output)throw new Error('Usage: pons-fork-cli.ts manifest.json output.json; set paid RPC and RPC_SESSION_BUDGET');
  runPonsForkManifest(manifest,output).then(r=>{console.log(JSON.stringify(r));if(r.failed)process.exitCode=1;})
    .catch(()=>{console.error('Pinned Pons fork run unavailable');process.exitCode=1;});
}
