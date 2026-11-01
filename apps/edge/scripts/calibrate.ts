/**
 * Calibration report for EKO's Elysium thresholds. Reads /v1/memory/calibration from a running edge (default the
 * production one) and prints, per measured feature, the share of launches that went bad in each bucket against the base
 * rate. Thresholds are refit by hand from this report, never automatically.
 *
 *   node --import tsx scripts/calibrate.ts [baseUrl] [at=3600] [target=halved|outcome]
 *
 * target halved (default): the price an hour in had halved by the next day (what EKO's Robinhood Chain thresholds were
 * fitted on). target outcome: rugged, honeypot or dumped by the next day.
 */
const [base = 'https://eko-edge-production.up.railway.app', at = '3600', target = 'halved'] = process.argv.slice(2);
const res = await fetch(`${base}/v1/memory/calibration?at=${at}&horizon=24h&target=${target}`);
if (!res.ok) throw new Error(`calibration: HTTP ${res.status}`);
const c = await res.json() as { samples: number; baseBadRate: number | null; outcomes: Record<string, number>; features: Record<string, { from: number | null; to: number | null; n: number; badRate: number | null }[]> };
console.log(`Features measured ${Number(at) / 60} min after launch; outcome by 24 h; target ${target}.`);
console.log(`Samples ${c.samples}; base bad rate ${c.baseBadRate === null ? 'n/a' : `${(c.baseBadRate * 100).toFixed(1)}%`}; outcomes ${JSON.stringify(c.outcomes)}\n`);
for (const [name, buckets] of Object.entries(c.features)) {
  console.log(name);
  for (const b of buckets) {
    const range = `${b.from === null ? '-inf' : b.from} .. ${b.to === null ? '+inf' : b.to}`.padEnd(16);
    const lift = b.badRate !== null && c.baseBadRate ? (b.badRate / c.baseBadRate).toFixed(2) : '-';
    console.log(`  ${range} n=${String(b.n).padStart(6)}  bad ${b.badRate === null ? '   -  ' : `${(b.badRate * 100).toFixed(1).padStart(5)}%`}  x${lift}${b.n < 30 ? '  (few samples)' : ''}`);
  }
}
