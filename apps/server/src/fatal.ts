import { writeSync } from 'node:fs';

let exiting = false;
/** Fatal paths cannot await cleanup or telemetry: either may be waiting on the failed connection. */
export function fatalExit(where: 'startup' | 'uncaughtException' | 'unhandledRejection'): never {
  if (!exiting) {
    exiting = true;
    // Fixed fields only: provider exceptions may contain credentials or SQL row data.
    try { writeSync(2, JSON.stringify({ level: 60, msg: 'EKO role halted', where }) + '\n'); } catch { /* Exit even if logging fails. */ }
  }
  process.exit(1);
}

export function installFatalHandlers() {
  process.on('uncaughtException', () => fatalExit('uncaughtException'));
  process.on('unhandledRejection', () => fatalExit('unhandledRejection'));
}
