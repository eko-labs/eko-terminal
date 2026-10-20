import { GhostReportStore, openDb } from '@eko/db';
import { ghostReportShare } from '@eko/shared';

// Local evidence preparation only. Fact approval uses the internal writer after
// review; no CLI flag can approve, publish, post or acquire evidence implicitly.
const [receiptId, predecessor] = process.argv.slice(2);
if (!receiptId) throw new Error('Usage: ghost-reports-cli <persisted-guard-receipt-id> [prior-report-hash]');
const db = await openDb({ databaseUrl: process.env.DATABASE_URL, pgliteDir: process.env.PGLITE_DIR });
try {
  const report = await new GhostReportStore(db).prepare(receiptId, { preRelease: true, supersedes: predecessor });
  process.stdout.write(JSON.stringify({ report, shareDraft: ghostReportShare(report) }, null, 2) + '\n');
} finally { await db.close(); }
