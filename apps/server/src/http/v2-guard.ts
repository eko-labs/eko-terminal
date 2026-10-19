import { serializeRadarResponse } from '../read/row-cache.js';
import { GuardConsumerReads } from '../read/guard-consumers.js';
import type { ReadServices } from './v1/reads.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AddressSchema, Bytes32Schema, FeedItemSchema } from '@eko/shared';
import type { GuardReadStore } from '../read/guard-store.js';
import { InputError, parse, sendError } from './v1/helpers.js';

/**
 * Register public v2 negotiated Guard/card/evidence/read APIs with strict input parsing. No wallet
 * session required. Missing indexed records/evidence returns not_found; input errors return
 * bad_request, other failures are logged and return internal_error. Stored source availability
 * controls the read projection.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function guardReadRoutes(app:FastifyInstance,store:GuardReadStore, services?:ReadServices) {
  await app.register(async v2=>{
    v2.setErrorHandler((err,_req,reply)=>{
      if(err instanceof InputError)return sendError(reply,'bad_request',err.message);
      v2.log.error(err,'Guard read failed');return sendError(reply,'internal_error','Internal error');
    });
    const address=(raw:unknown)=>parse(z.strictObject({address:AddressSchema}),raw).address;
    if (services) {
      const consumers = new GuardConsumerReads(services);
      const cursor = z.string().max(1024).optional();
      v2.get('/radar', async (req,reply) => {reply.serializer(serializeRadarResponse);const q=parse(z.strictObject({cursor,blueChip:z.enum(['true','false']).optional()}),req.query);return consumers.radar(q.cursor,q.blueChip==='true');});
      v2.get('/pairs', async req => { const q = parse(z.strictObject({stage:z.enum(['new','near_grad','migrated']).default('new'),cursor,blueChip:z.enum(['true','false']).optional()}),req.query); return consumers.pairs(q.stage,q.cursor,q.blueChip==='true'); });
      v2.get('/feed', async req => { const q = parse(z.strictObject({cursor,kinds:z.string().max(200).optional()}),req.query); return consumers.feed(q.kinds ? parse(z.array(FeedItemSchema.shape.kind),q.kinds.split(',')) : undefined,q.cursor); });
    }
    v2.get('/coins/:address',async(req,reply)=>await store.legacy.exists(address(req.params))?store.negotiatedCard(address(req.params),2):sendError(reply,'not_found','Token is not indexed.'));
    v2.get('/coins/:address/verdict',async(req,reply)=>await store.legacy.exists(address(req.params))?store.negotiatedVerdict(address(req.params),2):sendError(reply,'not_found','Token is not indexed.'));
    v2.get('/coins/:address/evidence/:id',async(req,reply)=>{
      const {address:coin,id}=parse(z.strictObject({address:AddressSchema,id:Bytes32Schema}),req.params);
      return await store.evidence(coin,id) ?? sendError(reply,'not_found','Evidence is unavailable at the current captured source.');
    });
    v2.get('/coins',async req=>store.list(parse(z.strictObject({cursor:z.string().max(1024).optional()}),req.query).cursor));
    v2.get('/radar/totals',async()=>store.totals());
    v2.get('/scan',async req=>store.scan(parse(z.strictObject({q:z.string().trim().min(1).max(120)}),req.query).q));
  },{prefix:'/v2'});
}
