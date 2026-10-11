import { LoopHeartbeat } from './loop-health.js';
import { runRetention, retentionFailure, type RetentionFailure, type ChainDb, type RetentionResult } from '@eko/db';
import { RETENTION_RULE_INPUTS } from '@eko/engines';
import { loadRegistry } from '@eko/chain';

export interface RetentionSettings { enabled?: boolean; settleHours?: number; rawDays?: number; swapDays?: number; transferDays?: number; ratingDays?: number; receiptHours?: number; receiptKeepCurrent?: boolean; dryRun?: boolean; quoteDays?: number; idleTokenDays?: number; pendingPoolDays?: number; feedDays?: number; dangerQuietDays?: number; quietCoinDays?: number }

/**
 * Run the configured retention (packages/db/src/retention.ts) on the singleton worker while backlogged, otherwise every ten minutes, each enabled
 * non-partition rule bounded to six seconds with a 115-second pass ceiling. Raw partitions run at start and hourly
 * in a dedicated maintenance session without a statement deadline. The app supplies report-only defaults. Quote
 * tokens are the address registry's verified `tokens.*` entries.
 */
export class RetentionWorker {
  readonly heartbeat: LoopHeartbeat;
  readonly partitionHeartbeat = new LoopHeartbeat(3_600_000);
  get partitionsEnabled() { return this.enabled && [this.settings.swapDays, this.settings.transferDays, this.settings.rawDays].some(value => value !== undefined); }
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private started = false;
  private backlogged = false;
  private nextRawPass = 0;
  constructor(private readonly db: ChainDb, private readonly settings: RetentionSettings,
    private readonly report: (result: RetentionResult | RetentionFailure) => void, private readonly intervalMs = 600_000) { this.heartbeat = new LoopHeartbeat(intervalMs); }
  get enabled() { return this.settings.enabled !== false && Object.entries(this.settings).some(([key,value]) => key !== 'enabled' && value !== undefined); }
  start() {
    if (this.started || !this.enabled) return;
    this.started = true;
    this.heartbeat.start();
    if (this.partitionsEnabled) this.partitionHeartbeat.start();
    this.nextRawPass = 0;
    void this.tick();
  }
  async stop() { this.started = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; await this.running; }
  tick(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.running) return this.running;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.running = this.pass().finally(() => {
      this.running = undefined;
      if (this.started) this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, this.backlogged ? 100 : this.intervalMs);
    });
    return this.running;
  }
  private async pass() {
    let phase = 'registry';
    try {
      const registry=loadRegistry();
      const quoteTokens = registry.entries()
        .filter(([key, entry]) => key.startsWith('tokens.') && entry.address !== 'TODO')
        .map(([, entry]) => String(entry.address).toLowerCase());
      const rawPartitions = Date.now() >= this.nextRawPass;
      if(rawPartitions)this.nextRawPass=Date.now()+3_600_000;
      phase = 'retention_pass';
      const result = await runRetention(this.db, { quoteTokens, ...RETENTION_RULE_INPUTS, poolManager:registry.addressOf('uniswapV4.poolManager') ?? undefined, ...this.settings, rawPartitions });
      this.heartbeat.complete();
      if (rawPartitions && this.partitionsEnabled) this.partitionHeartbeat.complete();
      this.backlogged = !result.dryRun && !result.finished;
      this.report(result);
    } catch (error) { this.backlogged = false; this.report(retentionFailure(error, phase)); } // Retry next interval; no SQL or row data enters logs.
  }
}
