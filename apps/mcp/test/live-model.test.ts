// The seven T tools end to end over the API's real schema (all three migration ledgers), an
// indexer-decoded fixture block and engine replay; offline PGlite, no ports, providers or RPC.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { z } from 'zod';
import { CoinCardSchema, JournalEntrySchema, PreflightResultSchema, ReceiptLookupSchema, SenseCensusResultSchema,
  VerdictSchema, type CoinCard } from '@eko/shared';
import { accounts } from '../../server/src/db/schema.js';
import { preflightFixture } from '../../server/test/preflight-fixture.js';
import { seedReadFixture, sampleAddress } from '../../server/test/read-fixture.js';
import { createMcpRuntime } from '../src/runtime.js';
import { modelText, UNTRUSTED_NOTICE, WITHHELD_TEXT } from '../src/tools.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv | Ajv2020) => void;
// Mirrors the MCP SDK client's Tool entry (2025-06-18/2025-11-25): both schemas must be objects.
const ClientToolSchema = z.object({ name: z.string(), description: z.string().min(40),
  inputSchema: z.object({ type: z.literal('object') }).loose(), outputSchema: z.object({ type: z.literal('object') }).loose() });
// The validators MCP clients compile outputSchema with (strict off, formats on), in both drafts.
const validators = [new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true }),
  new Ajv2020({ strict: false, validateFormats: true, validateSchema: false, allErrors: true })];
for (const ajv of validators) addFormats(ajv);

let f: Awaited<ReturnType<typeof preflightFixture>>;
let runtime: Awaited<ReturnType<typeof createMcpRuntime>>;
let card: CoinCard;
const publicUrl = 'https://mcp.eko.example/mcp';
const tools = new Map<string, Record<string, unknown>>();
beforeAll(async () => {
  f = await preflightFixture();
  card = await seedReadFixture(f.handle.chain, Date.now());
  runtime = await createMcpRuntime({ HARNESS_KEY_PEPPER: f.pepper, MCP_PUBLIC_URL: publicUrl, LAUNCH_WEEK_AGENT_LIMIT: '1',
    JOURNAL_KEK: f.kek.toString('hex'), JOURNAL_KEK_ID: f.keyId, JOURNAL_TOMBSTONE_PATH: f.path },
  undefined, async () => ({ ...f.handle, close: async () => {} }));
}, 60_000);
afterAll(async () => { await runtime?.app.close(); await f?.close(); });

async function owner(optIn: boolean) {
  const [account] = await f.handle.db.insert(accounts).values({ kind: 'wallet' }).returning();
  const agent = await f.harness.create(account!.id, { name: 'Sample live-model agent', kind: 'robinhood_mcp', preset: 'degen' }, 1);
  if (optIn) await f.journal.setConsent(account!.id, true);
  return { accountId: account!.id, agent, key: (await f.harness.createKey(account!.id, agent.id)).secret };
}
async function rpc(key: string, method: string, params?: object) {
  const response = await runtime.app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' } });
  expect(response.statusCode).toBe(200);
  return response.json();
}
/** Call a tool and check its result the way a strict MCP client does before the model sees it. */
async function call(key: string, name: string, args: object) {
  const result = (await rpc(key, 'tools/call', { name, arguments: args })).result;
  expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
  for (const ajv of validators) {
    const validate = ajv.compile(tools.get(name)!);
    expect(validate(result.structuredContent), `${name}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  }
  expect(result.notice).toBe(UNTRUSTED_NOTICE);
  // The model-facing JSON mirrors the result; third-party token text stays out of it.
  expect(result.content[1].text).not.toContain('Fixture coin');
  return result.structuredContent;
}

describe('seven T MCP tools on the API data model', () => {
  it('lists exactly the seven launch tools with client-valid schemas', async () => {
    const { key } = await owner(true);
    const init = (await rpc(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sample-client', version: '1' } })).result;
    expect(init).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, instructions: UNTRUSTED_NOTICE });
    const listed = (await rpc(key, 'tools/list')).result.tools;
    expect(listed.map((t: { name: string }) => t.name)).toEqual(
      ['coin_verdict', 'coin_card', 'playbook_match', 'census_summary', 'receipts_lookup', 'preflight', 'journal']);
    for (const tool of listed) {
      ClientToolSchema.parse(tool);
      for (const ajv of validators) ajv.compile(tool.outputSchema);
      tools.set(tool.name, tool.outputSchema);
    }
  });

  it('reads the stored verdict, card, playbooks, gated Census and verdict receipt', async () => {
    const { key } = await owner(true), coin = card.identity.address;
    const verdict = VerdictSchema.parse(await call(key, 'coin_verdict', { coin }));
    expect(verdict.coin).toBe(coin); expect(verdict.receipt.id).toBeTruthy();
    for (const flowWindow of ['5m', '1h', '24h'] as const) {
      const served = CoinCardSchema.parse(await call(key, 'coin_card', { coin, flowWindow }));
      expect(served.identity.address).toBe(coin); expect(served.flow.window).toBe(flowWindow);
      // No Watcher snapshot in this fixture: the window is explicitly unavailable, not zero flow.
      expect(served.meta?.flow?.unavailable).toBe(true);
      expect(served.identity.name.text).toBe('Fixture coin');
    }
    const playbooks = await call(key, 'playbook_match', { coin }) as { playbooks: { id: string }[] };
    expect(playbooks.playbooks.map(m => m.id)).toEqual(verdict.playbooks.map(m => m.id));
    const census = SenseCensusResultSchema.parse(await call(key, 'census_summary', {}));
    expect(census).toMatchObject({ gated: true, chain: [], coins: [] });
    const receipt = ReceiptLookupSchema.parse(await call(key, 'receipts_lookup', { id: verdict.receipt.id }));
    expect(receipt).toMatchObject({ id: verdict.receipt.id, status: 'pending' });
    expect((await call(key, 'coin_verdict', { coin: sampleAddress(77) }))).toEqual({ status: 'unavailable', reason: 'coin_unavailable' });
  });

  it('preflights against stored Senses, journals privately and finds the journal receipt', async () => {
    const { key, agent } = await owner(true), coin = card.identity.address;
    const start = JournalEntrySchema.parse(await call(key, 'journal', { kind: 'session_start', payload: { orders: [] } }));
    expect(start.agentId).toBe(agent.id);
    const context = { reportedAt: new Date().toISOString(), positions: [], cashUsd: 1000, dailyPnlUsd: 0 };
    const order = (ref: string, instrument: string, venue = 'rhc') => ({ clientOrderRef: ref, context,
      order: { venue, instrument, side: 'buy', orderType: 'market', notionalUsd: 25 } });
    // The stored engine verdict reaches the pure policy (this fixture's checks are still pending).
    const stored = VerdictSchema.parse(await call(key, 'coin_verdict', { coin }));
    const known = PreflightResultSchema.parse(await call(key, 'preflight', order('live-model-known', coin)));
    expect(known.senses?.verdict).toEqual(stored);
    expect(known.decision).toBe('deny');
    expect(known.reasons.some(r => r.startsWith('scan_pending'))).toBe(stored.level === 'pending');
    // A later engine verdict with a confirmed honeypot is refused from the stored row alone.
    await f.handle.chain.sql.query(`INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data)
      SELECT id||'-later',coin,valid_from_block+1,rules_version,signature,$2::jsonb FROM verdicts WHERE coin=$1 LIMIT 1`,
    [Buffer.from(coin.slice(2), 'hex'), JSON.stringify({ ...stored, level: 'danger', reasons: ['honeypot'],
      playbooks: [{ id: 'honeypot', level: 'danger', confidence: 1, evidence: [] }] })]);
    const honeypot = PreflightResultSchema.parse(await call(key, 'preflight', order('live-model-honeypot', coin)));
    expect(honeypot.decision).toBe('deny'); expect(honeypot.reasons[0]).toBe('honeypot: the sell simulation fails');
    const unknown = PreflightResultSchema.parse(await call(key, 'preflight', order('live-model-unknown', sampleAddress(77))));
    expect(unknown.decision).toBe('deny'); expect(unknown.reasons[0]).toMatch(/^scan_pending/);
    expect(unknown.senses?.verdict).toBeUndefined();
    const stock = PreflightResultSchema.parse(await call(key, 'preflight', order('live-model-stock', 'DEMO', 'robinhood')));
    expect(stock.decision).toBe('allow');
    // Replay returns the stored result for the same reference and order.
    expect(await call(key, 'preflight', order('live-model-stock', 'DEMO', 'robinhood'))).toEqual(stock);
    const outcome = JournalEntrySchema.parse(await call(key, 'journal', { kind: 'outcome', preflightId: stock.preflightId, payload: { filled: true } }));
    const privateReceipt = ReceiptLookupSchema.parse(await call(key, 'receipts_lookup', { id: outcome.id }));
    expect(privateReceipt).toMatchObject({ id: outcome.id, kind: 'harness_private', hash: outcome.commitment });
    expect(JSON.stringify(privateReceipt)).not.toContain('filled');
  });

  it('tells the agent to ask for journal opt-in instead of failing silently', async () => {
    const { key } = await owner(false);
    for (const [name, args] of [['journal', { kind: 'note', payload: {} }],
      ['preflight', { clientOrderRef: 'live-model-optin', order: { venue: 'robinhood', instrument: 'DEMO', side: 'sell', orderType: 'market', qty: 1 } }]] as const) {
      const result = (await rpc(key, 'tools/call', { name, arguments: args })).result;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ask the human to turn on the agent journal in EKO Settings');
    }
  });

  it('withholds token-authored text from the model-facing block while keeping its flags', async () => {
    const { key } = await owner(true);
    const result = (await rpc(key, 'tools/call', { name: 'coin_card', arguments: { coin: card.identity.address } })).result;
    const mirrored = JSON.parse(result.content[1].text);
    expect(result.structuredContent.identity.name.text).toBe('Fixture coin');
    expect(mirrored.identity.name).toEqual({ ...result.structuredContent.identity.name, text: WITHHELD_TEXT });
    expect(mirrored.identity.symbol.text).toBe(WITHHELD_TEXT);
    expect(result.content[1].text).toBe(modelText(result.structuredContent));
    expect({ ...mirrored, identity: result.structuredContent.identity, verdict: result.structuredContent.verdict,
      playbooks: result.structuredContent.playbooks }).toEqual(result.structuredContent);
  });
});
