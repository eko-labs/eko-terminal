/** Completion timestamps, never timer firings or pass starts. A first cycle has three periods to finish. */
export class LoopHeartbeat {
  private startedAt: number | null = null;
  private lastCycleAt: number | null = null;
  constructor(readonly periodMs: number, private readonly now = () => Date.now()) {}
  start() { this.startedAt ??= this.now(); }
  complete() { this.lastCycleAt = this.now(); }
  snapshot() {
    const age = this.now() - (this.lastCycleAt ?? this.startedAt ?? this.now());
    return { periodMs: this.periodMs, lastCycleAt: this.lastCycleAt,
      ok: this.startedAt !== null && age >= 0 && age <= this.periodMs * 3 };
  }
}

export function loopHealth(loops: Record<string, LoopHeartbeat>) {
  const checks = Object.fromEntries(Object.entries(loops).map(([name, heartbeat]) => [name, heartbeat.snapshot()]));
  return { ok: Object.values(checks).every(check => check.ok), loops: checks };
}
