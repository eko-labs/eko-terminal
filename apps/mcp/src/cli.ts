import { runMcpProcess } from './runtime.js';

try { await runMcpProcess(); }
catch { console.error('EKO MCP startup or shutdown failed (details withheld)'); process.exit(1); }
