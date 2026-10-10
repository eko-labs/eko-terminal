import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { seedReadReview } from './read-review-fixture.js';
import { launchE2eFixture, launchQuoteBackend } from './launch-e2e-fixture.js';
import type { Ctx } from '../src/app.js';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DemoFeed } from '../src/market/demoFeed.js';
// Preserve the existing externally provisioned fork server path. The launch runner never enters it.
if(process.env.LIVE_TRADING_ENABLED==='true') {
  const built=await buildApp(loadConfig(),{startBackground:false});
  await seedReadReview(built.ctx.dbh.chain);
  await built.app.listen({host:'127.0.0.1',port:built.ctx.cfg.PORT});
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void built.close().then(()=>process.exit(0));});
} else {
const artifacts=fileURLToPath(new URL('../../web/e2e/.artifacts/',import.meta.url));
await mkdir(artifacts,{recursive:true});
const dir=await mkdtemp(`${artifacts}launch-`),ledger=`${dir}/destruction.log`;
await writeFile(ledger,'eko-journal-destruction-v1\n',{mode:0o600});
// Reuse the production raw-HTML metadata responder, independently of Vite's dev shell.
await copyFile(new URL('../../web/index.html',import.meta.url),`${dir}/index.html`);
let fixtureCtx:Ctx;
const built=await buildApp(loadConfig({NODE_ENV:'test',APP_ROLE:'api',PGLITE_DIR:':memory:',
  PORT:process.env.PORT,PUBLIC_ORIGIN:process.env.PUBLIC_ORIGIN,MARKET_DATA_SOURCE:'onchain',
  SERVE_WEB:'true',WEB_DIST_DIR:dir,
  RUN_WORKER:'false',ENABLE_DEV_ROUTES:'true',LIVE_TRADING_ENABLED:'false',FLAGS:'',LOG_LEVEL:'warn',
  RH_MAINNET_RPC_URL:'http://127.0.0.1:9',RH_TESTNET_RPC_URL:'http://127.0.0.1:9',
  SESSION_SECRET:randomBytes(32).toString('hex'),JOURNAL_KEK:randomBytes(32).toString('hex'),
  JOURNAL_KEK_ID:'sample-ephemeral-kek',JOURNAL_TOMBSTONE_PATH:ledger,HARNESS_KEY_PEPPER:randomBytes(32).toString('hex'),
  LAUNCH_WEEK_AGENT_LIMIT:'10'}),{startBackground:false,feed:new DemoFeed(129),tradeBackend:launchQuoteBackend(()=>fixtureCtx)});
fixtureCtx=built.ctx;
await seedReadReview(built.ctx.dbh.chain);
await launchE2eFixture(built.app,built.ctx);
// Local simulated prices support the retained paper API; indexed T reads still use the database.
await built.ctx.market.start();
await built.app.listen({host:'127.0.0.1',port:built.ctx.cfg.PORT});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void built.close().then(()=>rm(dir,{recursive:true,force:true})).then(()=>process.exit(0));});
}
