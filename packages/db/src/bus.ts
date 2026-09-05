import pg from 'pg';
import type { BusMessage } from './client.js';
import { GuardBusEventSchema } from '@eko/shared';
export interface EngineBus { subscribe(handler: (message: BusMessage) => void): Promise<() => Promise<void>> }
export class InProcessBus implements EngineBus {
  private handlers = new Set<(message: BusMessage) => void>();
  async subscribe(handler: (message: BusMessage) => void) { this.handlers.add(handler); return async () => { this.handlers.delete(handler); }; }
  publish(message: BusMessage) { for (const handler of this.handlers) handler(message); }
}
const topics: BusMessage['topic'][] = ['chain_block','chain_reorg','swap','pair_created','liquidity','pons_exempt','flow_updated','card_updated','verdict_created','guard_evidence_created','guard_coverage_created','guard_role_created','guard_verdict_created','guard_revision_invalidated'];
/** A dedicated connection owns LISTEN. Polling continues if this connection drops. */
export class PostgresBus implements EngineBus {
  constructor(private databaseUrl: string) {}
  async subscribe(handler: (message: BusMessage) => void) {
    const client = new pg.Client({ connectionString:this.databaseUrl });
    client.on('error', () => { /* Worker polling remains authoritative. */ });
    await client.connect();
    client.on('notification', message => {
      const topic=message.channel.replace(/^eko_/,'') as BusMessage['topic'];
      if (!topics.includes(topic) || !message.payload) return;
      try {
        const ids: unknown=JSON.parse(message.payload);
        if (topic.startsWith('guard_') && !GuardBusEventSchema.safeParse({ topic: topic.replaceAll('_','.'), ids }).success) return;
        if (ids && typeof ids==='object' && !Array.isArray(ids) && Object.values(ids).every(v => typeof v==='string' || typeof v==='number')) handler({ topic,ids:ids as BusMessage['ids'] });
      } catch { /* Invalid notifications cannot change engine state. */ }
    });
    for (const topic of topics) await client.query(`LISTEN eko_${topic}`);
    return async () => { await client.end(); };
  }
}
