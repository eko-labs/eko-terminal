import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { RpcGuardError, rpcStopReason } from '@eko/chain';
import { reportIndexerError } from '../src/guard-stop.js';
describe('indexer exit reasons', () => {
  it.each(['rpc_session_budget_reached', 'rpc_budget_exhausted', 'shutdown_requested'] as const)('reports %s as a clean stop through viem error causes', reason => {
    const logger = vi.fn();
    const error = new Error('Contract read unavailable', { cause: new Error('Request refused', { cause: new RpcGuardError(reason) }) });
    expect(reportIndexerError(error, logger)).toBe(0);
    expect(logger.mock.calls).toEqual([['indexer_stopped', { reason }]]);
  });
  it('reports exhausted transient transport retries as rpc_unavailable with exit code one',()=>{
    const logger=vi.fn();
    const error=new Error('Request failed',{cause:new RpcGuardError('rpc_unavailable','fetch failed')});
    expect(reportIndexerError(error,logger)).toBe(1);
    expect(logger).toHaveBeenCalledWith('indexer_halted',expect.objectContaining({reason:'rpc_unavailable'}));
  });
  it('keeps genuine ingest failures as failures, without matching guard text in a request', () => {
    const logger = vi.fn();
    const error = new Error('rpc_session_budget_reached appeared in request data');
    expect(rpcStopReason(error)).toBeUndefined(); expect(reportIndexerError(error, logger)).toBe(1);
    expect(logger).toHaveBeenCalledWith('indexer_halted', expect.objectContaining({ reason: 'startup_or_ingest_failure' }));
  });
  it('logs only known functions and relative source locations, including wrapped causes',()=>{
    const logger=vi.fn(),cause=new Error('sample request value');
    cause.stack=`Error: sample request value
    at LogHeadFollower.applyWindow (file:///tmp/demo-account/project/apps/indexer/src/log-head.ts:342:29)
    at sample-provider-token (file:///tmp/demo-account/project/apps/indexer/src/log-head.ts:320:9)
    at fetch (https://paid.invalid/apps/indexer/src/log-head.ts?key=sample-provider-token:1:2)
    at leakedValue (/tmp/private/sample-value.ts:1:2)
    at async LogHeadFollower.processTick (/tmp/demo-account/project/apps/indexer/src/log-head.ts:146:7)`;
    const error=new Error('ingest failed',{cause});error.stack='Error: ingest failed';
    reportIndexerError(error,logger);
    expect(logger.mock.calls[0][1].stack_frames).toEqual([
      {function:'LogHeadFollower.applyWindow',file:'apps/indexer/src/log-head.ts',line:342},
      {function:'anonymous',file:'apps/indexer/src/log-head.ts',line:320},
      {function:'LogHeadFollower.processTick',file:'apps/indexer/src/log-head.ts',line:146},
    ]);
    expect(JSON.stringify(logger.mock.calls[0][1].stack_frames)).not.toMatch(/demo-account|sample|https|tmp/);
  });

});

it('exits non-zero for invalid indexer configuration', () => {
  const result=spawnSync(process.execPath,['--import','tsx','src/cli.ts'],{cwd:new URL('..',import.meta.url),env:{PATH:process.env.PATH,APP_ROLE:'indexer',RPC_HTTP_URL:'invalid'},encoding:'utf8'});
  expect(result.status).toBe(1);expect(result.stdout).toContain('indexer_halted');
});
