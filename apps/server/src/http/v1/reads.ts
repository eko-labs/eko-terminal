import { serializeRadarResponse } from '../../read/row-cache.js';
import { recordRouteRejection } from '../../obs/rate-limits.js';
import { readCensus } from '@eko/db';
import { z } from 'zod';
import { AddressSchema, FeedItemSchema, TfSchema, ScoreboardKindSchema } from '@eko/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthService } from '../auth.js';
import type { PointsService } from '../../points/service.js';
import type { ReadStore } from '../../read/store.js';
import { RadarService } from '../../read/radar.js';
import { PairsService } from '../../read/pairs.js';
import { FeedService } from '../../read/feed.js';
import { CoinsService } from '../../read/coins.js';
import { GuardReadStore } from '../../read/guard-store.js';
import { ScoreboardService } from '../../read/scoreboard.js';
import { GradeOutcomesService } from '../../read/grade-outcomes.js';
import { ScanService } from '../../read/scan.js';
import { metrics } from '../../obs/metrics.js';
import { parse, sendError } from './helpers.js';
const blueChip=z.enum(['true','false']).optional().transform(v=>v==='true');
const cursor=z.string().max(1024).optional();
const range=z.object({from:z.coerce.number().int().nonnegative(),to:z.coerce.number().int().nonnegative()}).refine(r=>r.to>r.from && r.to-r.from<=366*86400,{message:'Invalid time range'});
export function readServices(store:ReadStore,points?:PointsService,phase:()=>string=()=> 'launch_week') {
  return {store,points,grades:new GradeOutcomesService(store),scoreboard:new ScoreboardService(store.db,()=>store.now(),phase),guard:new GuardReadStore(store),radar:new RadarService(store),pairs:new PairsService(store),feed:new FeedService(store),coins:new CoinsService(store),scan:new ScanService(store)};
}
export type ReadServices=ReturnType<typeof readServices>;
/**
 * Register public indexed coin/feed/radar/pair/candle/scan, precision-gated Census and coverage-
 * qualified Scoreboard APIs with validated queries and a
 * shared 30/min scan group budget. Optional wallet session attributes eligible scan points; demo
 * sessions do not. Missing records/rate limits return named errors and storage failures propagate;
 * pending scans do not fabricate verdicts.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function readRoutes(app:FastifyInstance,services:ReadServices,auth?:AuthService) {
  const {radar,pairs,feed,coins,scan}=services;
  app.get('/scoreboard/grades',async()=>services.grades.read());
  app.get('/scoreboard',async req=>{const q=parse(z.strictObject({kind:ScoreboardKindSchema.default('calls'),cursor,limit:z.coerce.number().int().min(1).max(100).default(50)}),req.query);return services.scoreboard.list(q.kind,q.cursor,q.limit);});
  app.get('/census',async()=>readCensus(services.store.db,services.store.now()));
  app.get('/radar',async(req,reply)=>{reply.serializer(serializeRadarResponse);const q=parse(z.object({cursor,blueChip,mode:z.enum(['safe','degen']).optional(),lens:z.string().max(64).optional()}),req.query);return radar.list(q.cursor,q.blueChip);});
  app.get('/pairs',async req=>{const q=parse(z.object({stage:z.enum(['new','near_grad','migrated']).default('new'),cursor,blueChip}),req.query);return pairs.list(q.stage,q.cursor,q.blueChip);});
  app.get('/feed',async req=>{const q=parse(z.object({cursor,kinds:z.string().max(200).optional()}),req.query);const kinds=q.kinds ? parse(z.array(FeedItemSchema.shape.kind),q.kinds.split(',')) : undefined;return feed.list(kinds,q.cursor);});
  const address=(params:unknown)=>parse(z.object({address:AddressSchema}),params).address;
  const missing=(reply:Parameters<typeof sendError>[0])=>sendError(reply,'not_found','No coin card is available for this address. Token identity may be indexed; search can show its current status.');
  app.get('/coins/:address',async(req,reply)=>{const card=await coins.card(address(req.params));return card ? {...card,delayedSec:0} : missing(reply);});
  app.get('/coins/:address/verdict',async(req,reply)=>{const verdict=await coins.verdict(address(req.params));return verdict ? {...verdict,delayedSec:0} : sendError(reply,'not_found','No verdict has been recorded for this address yet.');});
  app.get('/coins/:address/candles',async(req,reply)=>{const a=address(req.params),q=parse(range.and(z.object({tf:TfSchema})),req.query);if(!await services.store.exists(a))return sendError(reply,'not_found','Token is not indexed.');return coins.candles(a,q.tf,q.from,q.to);});
  app.get('/coins/:address/markers',async(req,reply)=>{const a=address(req.params);const q=parse(range,req.query);if(!await services.store.exists(a))return sendError(reply,'not_found','Token is not indexed.');return coins.markers(a,q.from,q.to);});
  app.get('/coins/:address/flow',async(req,reply)=>{const a=address(req.params),q=parse(z.object({window:z.enum(['5m','1h','24h']).default('1h')}),req.query);return await coins.flow(a,q.window) ?? missing(reply);});
  // A shared route group budget prevents callers bypassing scan limits by switching methods.
  const buckets=new Map<string,{count:number;until:number}>();
  app.addHook('preHandler',async(req,reply)=>{
    if(!['/v1/scan','/v1/scan/:id'].includes(req.routeOptions.url ?? ''))return;
    const now=Date.now();
    const key=req.account?.id ?? req.ip;
    for(const [id,bucket] of buckets)if(bucket.until<=now)buckets.delete(id);
    const bucket=buckets.get(key) ?? {count:0,until:now+60000};buckets.set(key,bucket);
    if(++bucket.count>30){recordRouteRejection(app,req,req.account?.id?'session':'address');reply.header('retry-after',String(Math.ceil((bucket.until-now)/1000)));return sendError(reply,'rate_limited','Scan limit reached.',{retryAfterSec:Math.ceil((bucket.until-now)/1000)});}
  });
  app.addHook('onResponse',async(req,reply)=>{
    if(['/v1/scan','/v1/scan/:id'].includes(req.routeOptions.url ?? ''))metrics.observe('scan.response_ms',reply.elapsedTime);
  });
  const query=z.string().trim().min(1).max(120);
  const scanAccount=async(req:FastifyRequest)=>req.demoSession ? null : auth?.fromToken(auth.readCookie(req));
  const createScan=async(req:FastifyRequest,q:string)=>{
    const result=await scan.scan(q),account=await scanAccount(req);
    if(account?.kind==='wallet' && (result.status==='ready' || result.status==='pending'))
      await services.points?.scanCreated(result.id,account.id,new Date().toISOString());
    return {...result,delayedSec:0};
  };
  app.get('/scan',async req=>createScan(req,parse(z.object({q:query}),req.query).q));
  app.post('/scan',async req=>createScan(req,parse(z.object({query}).strict(),req.body).query));
  app.get('/scan/:id',async(req,reply)=>{
    const id=parse(z.object({id:z.string().regex(/^scan-[a-f0-9]{64}$/)}),req.params).id;
    const result=await scan.get(id);
    const account=await scanAccount(req);
    if(result?.status==='ready' && account?.kind==='wallet')
      await services.points?.scanOpened(id,account.id,new Date().toISOString());
    return result ? {...result,delayedSec:0} : sendError(reply,'not_found','Scan not found.');
  });
}
