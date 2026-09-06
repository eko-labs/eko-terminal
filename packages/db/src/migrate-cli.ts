import { openDb, migrate } from './client.js';
const db = await openDb({ databaseUrl: process.env.DATABASE_URL, pgliteDir: process.env.PGLITE_DIR });
try { await migrate(db); console.log(JSON.stringify({ event: 'indexer_migrations_applied' })); }
finally { await db.close(); }
