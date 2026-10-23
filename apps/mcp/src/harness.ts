import { PreflightService } from '../../server/src/harness/preflight.js';
import { JournalService } from '../../server/src/harness/journal.js';
import { ToolRegistry } from './tools.js';

/**
 * Register preflight and encrypted journal write handlers using the transport's resolved account
 * and agent, never request-supplied identity. Host wires configured services; duplicate registration
 * throws and invocation validation/storage failures propagate through the MCP error envelope.
 */
export function registerHarnessTools(tools: ToolRegistry, preflight: PreflightService, journal: JournalService) {
  return tools.register('preflight', (input, context) => preflight.run(
    { accountId: context.accountId, agentId: context.agent.id }, input))
    .register('journal', (input, context) => journal.append(context.accountId, context.agent.id, input));
}
