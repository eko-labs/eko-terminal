import { installFatalHandlers } from './fatal.js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRole, roleStartupMessage, runRole } from './roles.js';

installFatalHandlers();

try {
  const plan = planRole(process.env, dirname(fileURLToPath(import.meta.url)));
  process.exitCode = await runRole(plan);
} catch (error) {
  // Provider/connection errors can contain runtime credentials; keep startup output bounded.
  console.error(roleStartupMessage(error));
  process.exit(1);
}
