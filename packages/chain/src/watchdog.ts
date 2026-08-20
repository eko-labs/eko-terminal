export type StallReason = 'no_progress' | 'head_unobserved' | 'no_heartbeat';
export interface WatchdogState {
  cursor: bigint | null; head: bigint | null; blocksBehind: number | null;
  /** How long work has been pending without forward progress (0 when current). */
  idleMs: number;
  sinceProgressMs: number; headAgeMs: number | null;
}
export interface WatchdogOptions {
  /** Event prefix: `<role>_stalled`, `<role>_lag`, `<role>_head_probe_failed`. */
  role: string;
  /** No forward progress for this long, while work is pending, is a stall. */
  stallMs: number;
  /**
   * Indexer mode: progress is a block cursor, and only time spent behind an observed chain head
   * counts. Without it (engines), any silence of `progress()` for `stallMs` is a stall.
   */
  trackHead?: boolean;
  paused?: () => boolean;
  /** An independent chain-head read used when the worker has not reported one recently. */
  probe?: () => Promise<bigint>;
  probeMs?: number; probeTimeoutMs?: number;
  /** A head that nobody, probe included, can read for this long is also a stall (default 2 x stallMs). */
  headSilenceMs?: number;
  checkMs?: number; reportMs?: number;
  now?: () => number;
  log: (event: string, fields: Record<string, unknown>) => void;
  /** Called with each periodic lag report; returned fields join the log line. */
  onReport?: (state: WatchdogState) => Record<string, unknown> | void;
  /** Default: process.exit. The platform's restart policy brings the process back. */
  exit?: (code: number) => void;
}
const json = (n: bigint | null) => n == null ? null : n.toString();
/**
 * Exits a process that is alive but no longer moving. Checks are synchronous and never wait on
 * the work they supervise, so a hung database query or RPC cannot also hang the watchdog.
 */
export class ProgressWatchdog {
  private readonly now: () => number;
  private readonly startedAt: number;
  private cursor: bigint | null = null; private progressAt: number;
  private head: bigint | null = null; private headAt: number | null = null;
  private behindSince: number | null = null;
  private reportedAt: number; private probing = false; private timer?: ReturnType<typeof setInterval>;
  private tripped = false;
  private wasPaused = false;
  constructor(private readonly options: WatchdogOptions) {
    if (!(options.stallMs > 0)) throw new Error('Invalid watchdog stall threshold');
    this.now = options.now ?? Date.now;
    this.startedAt = this.progressAt = this.reportedAt = this.now();
  }
  /** Forward progress. In head mode only a higher cursor counts; a lower one (reorg rollback) is adopted silently. */
  progress(cursor?: bigint) {
    const now = this.now();
    if (cursor === undefined || !this.options.trackHead) { this.progressAt = now; return; }
    if (this.cursor != null && cursor === this.cursor) return;
    const advanced = this.cursor == null || cursor > this.cursor;
    this.cursor = cursor;
    if (!advanced) return;
    this.progressAt = now;
    this.behindSince = this.head != null && this.head > cursor ? now : null;
  }
  /** A chain head read by the worker or the probe. */
  observeHead(n: bigint) {
    const now = this.now();
    this.headAt = now;
    if (this.head == null || n > this.head) this.head = n;
    // An unknown cursor is pending work too: the first tick must read it.
    if (this.cursor == null || this.head > this.cursor) this.behindSince ??= now;
    else this.behindSince = null;
  }
  state(): WatchdogState {
    const now = this.now();
    return { cursor: this.cursor, head: this.head,
      blocksBehind: this.cursor != null && this.head != null ? Number(this.head > this.cursor ? this.head - this.cursor : 0n) : null,
      idleMs: this.options.trackHead ? this.behindSince == null ? 0 : now - this.behindSince : now - this.progressAt,
      sinceProgressMs: now - this.progressAt, headAgeMs: this.headAt == null ? null : now - this.headAt };
  }
  /** Evaluate once: probe, report, and trip when stalled. Returns the stall reason, if any. */
  check(): StallReason | undefined {
    if (this.tripped) return undefined;
    const now = this.now(), { stallMs } = this.options;
    if (this.options.paused?.()) { this.wasPaused = true; return undefined; }
    if (this.wasPaused) {
      this.wasPaused = false; this.progressAt = now; this.headAt = now;
      if (this.behindSince != null) this.behindSince = now;
    }
    if (now - this.reportedAt >= (this.options.reportMs ?? 60_000)) { this.reportedAt = now; this.report(); }
    let reason: StallReason | undefined;
    if (!this.options.trackHead) { if (now - this.progressAt >= stallMs) reason = 'no_heartbeat'; }
    else if (this.behindSince != null && now - this.behindSince >= stallMs) reason = 'no_progress';
    else if (now - (this.headAt ?? this.startedAt) >= (this.options.headSilenceMs ?? 2 * stallMs)) reason = 'head_unobserved';
    if (reason) { this.trip(reason); return reason; }
    if (this.options.trackHead && this.options.probe && !this.probing && now - (this.headAt ?? this.startedAt) >= (this.options.probeMs ?? 60_000)) void this.runProbe();
    return undefined;
  }
  start() {
    this.timer ??= setInterval(() => this.check(), this.options.checkMs ?? 15_000);
    // Supervises a live process; it must not keep a finished one alive.
    this.timer.unref?.();
    return this;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private report() {
    const state = this.state();
    const extra = this.options.onReport?.(state) ?? {};
    this.options.log(`${this.options.role}_lag`, { cursor: json(state.cursor), head: json(state.head), blocks_behind: state.blocksBehind,
      idle_ms: state.idleMs, since_progress_ms: state.sinceProgressMs, head_age_ms: state.headAgeMs, ...extra });
  }
  private async runProbe() {
    this.probing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = this.options.probeTimeoutMs ?? 20_000;
      const head = await Promise.race([this.options.probe!(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`head probe timed out after ${timeout} ms`)), timeout);
      })]);
      this.observeHead(head);
    } catch (error) {
      this.options.log(`${this.options.role}_head_probe_failed`, { reason: error instanceof Error && /timed out/.test(error.message) ? 'timeout' : 'rpc_error' });
    } finally { clearTimeout(timer); this.probing = false; }
  }
  private trip(reason: StallReason) {
    this.tripped = true; this.stop();
    const state = this.state();
    this.options.log(`${this.options.role}_stalled`, { reason, stall_after_ms: this.options.stallMs, idle_ms: state.idleMs,
      since_progress_ms: state.sinceProgressMs, head_age_ms: state.headAgeMs, cursor: json(state.cursor), head: json(state.head),
      blocks_behind: state.blocksBehind, action: 'exit_for_restart' });
    (this.options.exit ?? (code => process.exit(code)))(1);
  }
}
