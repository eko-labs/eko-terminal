import { parseFlagOverride } from '../../flags/service.js';
import { createDemoToken } from './demo.js';

try {
  const flags = [...parseFlagOverride(process.argv.slice(2).join(','))];
  console.log(createDemoToken(flags, process.env.DEMO_SECRET ?? ''));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
