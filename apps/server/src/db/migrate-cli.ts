import { loadConfig } from '../config.js';
import { openDb, runMigrations } from './client.js';

const cfg = loadConfig();
const handle = await openDb({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DIR });
await runMigrations(handle);
await handle.close();
console.log(`Migrations applied (${handle.driver}).`);
