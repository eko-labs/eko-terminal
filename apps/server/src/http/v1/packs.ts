import { PackSchema } from '@eko/shared';
import type { FastifyInstance } from 'fastify';
import generated from '../../../../../harness-packs/generated/packs.json' with { type: 'json' };

export const harnessPacks = generated.map(pack => PackSchema.parse(pack));
/**
 * Register the public no-store pack listing. When the deployment knows its public MCP endpoint
 * (`MCP_PUBLIC_URL`, validated HTTPS /mcp), templates arrive with it filled in; otherwise they keep
 * `{{MCP_URL}}` for the client to fill. `{{API_KEY}}` is always left for the browser. Keep the
 * connector pack at D0 until accepted OAuth readiness; no authentication, connector activation or
 * generated pack mutation occurs.
 */
export async function packRoutes(app: FastifyInstance, mcpUrl?: string) {
  const packs = harnessPacks.map(pack => ({ ...pack,
    ...(mcpUrl ? { configTemplate: pack.configTemplate.replaceAll('{{MCP_URL}}', mcpUrl) } : {}),
    // TODO(spec): Promote the connector only after task 099's accepted OAuth
    // readiness evidence. An environment toggle alone is not readiness.
    ...(pack.platform === 'claude_connector' ? { stage: 'D0' as const } : {}) }));
  app.get('/packs', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return packs;
  });
}
