import { riskModeLabel } from '../copy/shell';
import { useEffect, useRef, useState } from 'react';
import { useConnection } from 'wagmi';
import { z } from 'zod';
import { AgentSchema, OAuthRequestSchema, OAuthConsentResultSchema, type Agent, type OAuthRequest, type OAuthConsent, type OAuthScope } from '@eko/shared';
import { fetchParsed } from '../lib/api';
import { siweSignIn } from '../lib/trade';
import { useApp } from '../store/app';
import { ADVISORY, NON_AFFILIATION } from '../copy';

export const REQUIRED_SCOPES: OAuthScope[] = ['senses:read', 'preflight', 'journal'];
/** Review and explicit confirmation are separate actions. Never consent on load. */
export function ConsentForm({ request, agents, busy, submit }: { request: OAuthRequest; agents: Agent[]; busy: boolean; submit: (input: OAuthConsent) => void }) {
  const available = agents.filter(agent => agent.status !== 'disconnected');
  const [agentId, setAgentId] = useState(available[0]?.id ?? ''), [name, setName] = useState(''), [preset, setPreset] = useState<'safe' | 'balanced' | 'degen'>('balanced');
  const [scopes, setScopes] = useState(request.scopes), [confirm, setConfirm] = useState(false);
  const selected = !!agentId || !!name.trim();
  const decision = (decision: 'approve' | 'deny') => submit({ requestId: request.id, decision, scopes,
    ...(decision === 'approve' ? agentId ? { agentId } : { newAgentName: name.trim(), preset } : {}) });
  return <section className="panel"><div className="panel-body">
    <h1>Connect an agent</h1><p>Client name · Untrusted text</p><p>{request.clientName.text}</p>
    <p>Return to <strong>{request.redirectHost}</strong></p><p>Resource: <code>{request.resource}</code></p>
    <fieldset disabled={busy || confirm}><legend>Requested scopes</legend>{request.scopes.map(scope => <label className="field" key={scope}>
      <span><input type="checkbox" checked={scopes.includes(scope)} disabled={REQUIRED_SCOPES.includes(scope)} onChange={e => setScopes(e.target.checked ? [...scopes, scope] : scopes.filter(s => s !== scope))} /> {scope}{REQUIRED_SCOPES.includes(scope) && ' (required)'}</span>
    </label>)}</fieldset>
    <fieldset disabled={busy || confirm}><legend>Choose or create your agent</legend>
      <label className="field"><span>Agent</span><select className="input" value={agentId} onChange={e => setAgentId(e.target.value)}>
        {available.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}<option value="">Create a new agent</option>
      </select></label>
      {!agentId && <><label className="field"><span>New agent name</span><input className="input" maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="field"><span>Policy preset</span><select className="input" value={preset} onChange={e => setPreset(e.target.value as typeof preset)}><option value="safe">{riskModeLabel('safe')}</option><option value="balanced">Balanced</option><option value="degen">Degen</option></select></label>
        <p>Creation follows your account’s agent limit.</p></>}
    </fieldset>
    {confirm ? <div role="group" aria-label="Confirm connector consent"><p>Allow this client to use the selected scopes as this agent?</p><button className="btn btn-primary" disabled={busy} onClick={() => decision('approve')}>Confirm approval</button><button className="btn" disabled={busy} onClick={() => setConfirm(false)}>Back</button></div>
      : <button className="btn btn-primary" disabled={busy || !selected} onClick={() => setConfirm(true)}>Approve</button>}
    <button className="btn" disabled={busy} onClick={() => decision('deny')}>Deny</button>
    <p>EKO never receives your Robinhood credentials. Your agent keeps its own Robinhood connection.</p><p>{ADVISORY}</p><p>{NON_AFFILIATION}</p>
  </div></section>;
}
export default function OAuthConsentPage() {
  const account = useApp(s => s.account), requestId = new URLSearchParams(location.search).get('request');
  const [request, setRequest] = useState<OAuthRequest | null>(null), [agents, setAgents] = useState<Agent[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, reload] = useState(0);
  const run = useRef(0), inFlight = useRef(false);
  const connection = useConnection(), wallet = account?.walletAddress;
  const signedIn = account?.kind === 'wallet' && !!connection.address && wallet === connection.address.toLowerCase();
  useEffect(() => {
    const c = new AbortController(), generation = ++run.current;
    setRequest(null); setAgents([]); setError('');
    if (!signedIn) return () => c.abort();
    if (!requestId || !z.uuid().safeParse(requestId).success) { setError('This consent link is invalid. Start again in your connector.'); return () => c.abort(); }
    void Promise.all([fetchParsed(`/oauth/requests/${encodeURIComponent(requestId)}`, OAuthRequestSchema, { signal: c.signal }),
      fetchParsed('/agents', z.object({ agents: z.array(AgentSchema) }), { signal: c.signal })]).then(([request, list]) => {
      if (!c.signal.aborted && run.current === generation) { setRequest(request); setAgents(list.agents); }
    }).catch((e: Error) => { if (!c.signal.aborted) setError(e.message); });
    return () => { c.abort(); run.current++; };
  }, [requestId, wallet, signedIn, revision]);
  const signIn = async () => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError('');
    try { await siweSignIn(); reload(v => v + 1); } catch (e) { setError((e as Error).message); } finally { inFlight.current = false; setBusy(false); }
  };
  const submit = async (input: OAuthConsent) => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(''); const generation = run.current;
    try {
      const result = await fetchParsed('/oauth/consent', OAuthConsentResultSchema, { body: input });
      // The callback comes from the API; never take a redirect URL from query parameters.
      if (run.current === generation) window.location.assign(result.redirect);
    } catch (e) { setError((e as Error).message); } finally { inFlight.current = false; setBusy(false); }
  };
  return <div className="page">{error && <p role="alert">{error}</p>}
    {!signedIn && <p>Connect your wallet, then sign in to review this request.</p>}
    <p>Consent requires a wallet signature within the last hour.</p><button className="btn" disabled={busy} onClick={() => void signIn()}>Sign in again with wallet</button>
    {request && signedIn && <ConsentForm key={`${request.id}:${wallet}`} request={request} agents={agents} busy={busy} submit={input => void submit(input)} />}
  </div>;
}
