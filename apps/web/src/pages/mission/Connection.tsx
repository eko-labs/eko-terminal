import { MISSION_LABELS as L } from '../../copy/mission';
import { useState } from 'react';
import type { Agent, ApiKeyInfo, Flags } from '@eko/shared';
import { api } from '../../lib/api';
import { createKey, loadKeys } from '../../lib/mission';
import { IconCheck, IconKey } from '../../components/icons';
import { UntrustedText } from '../../components/ui';
import { MISSION_COPY as C } from '../../copy/mission';
import { MissionDialog } from './parts';
import { OneTimeKey } from './OneTimeKey';
import type { demoConnections } from '../../mocks/demo/mission';
import { GuardBadge, guardLine } from './parts';

// TODO(spec): ApiKeyInfo does not expose role addresses/permissions or venue-key
// metadata. Prototype connection panels are mock-only until that contract exists.
export default function Connection({ agent, keys, flags, onKeys, metadata }: { agent: Agent; keys: ApiKeyInfo[]; flags: Partial<Flags>; onKeys: (keys: ApiKeyInfo[]) => void; metadata?: typeof demoConnections[keyof typeof demoConnections] }) {
  const [revoke, setRevoke] = useState<ApiKeyInfo | null>(null), [secret, setSecret] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const reload = async () => onKeys((await loadKeys(agent.id)).keys);
  const issue = async () => { if (busy) return; setBusy(true); setError(''); try { const k = await createKey(agent.id); setSecret(k.secret); await reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const remove = async () => { if (!revoke || busy) return; setBusy(true); setError(''); try { await api(`/agents/${encodeURIComponent(agent.id)}/keys/${encodeURIComponent(revoke.keyId)}`, { method: 'DELETE' }); await reload(); setRevoke(null); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const onchain = metadata && 'onchain' in metadata ? metadata.onchain : undefined, venue = metadata && 'venueKey' in metadata ? metadata.venueKey : undefined;
  return <div className="mc-keys">{keys.map((k) => <section className="panel" key={k.keyId}><div className="panel-head"><h3>{k.kind === 'oauth' ? L.oauthGrant : L.harnessKey}</h3><span className="tag">{k.revokedAt ? L.revoked : k.kind === 'oauth' ? L.oauth : L.mcpAuthorizationHeader}</span></div><div className="panel-body"><div className="mc-secret"><IconKey /><span className="addr">{k.prefix}••••••••</span></div><dl className="kv"><dt>{L.usedBy}</dt><dd>{k.clientName ? <UntrustedText value={k.clientName} /> : agent.name}</dd><dt>{L.created}</dt><dd>{new Date(k.createdAt).toLocaleDateString('en-US')}</dd><dt>{L.lastUsed}</dt><dd>{k.revokedAt ? '—' : k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('en-US') : L.notYet}</dd></dl>{!k.revokedAt && <div className="mc-row-btns"><button className={"btn btn-sm btn-ghost mc-kill-link"} onClick={() => setRevoke(k)}>{k.kind === 'oauth' ? L.revokeGrant : L.revoke}</button></div>}</div></section>)}
    {agent.kind === 'robinhood_mcp' && <section className="panel"><div className="panel-head"><h3>{L.robinhoodConnection}</h3><span className="tag">{L.separateFromEko}</span></div><div className="panel-body"><p className="mc-p">{C.robinhoodConnection}</p><a href="https://robinhood.com/account/settings" className={"btn btn-sm"} target="_blank" rel="noreferrer">{L.openRobinhood}</a></div></section>}
    {agent.kind === 'onchain' && flags.onchain_guardrails && onchain && <section className={"panel mc-keys-wide"}><div className="panel-head"><h3>{L.onChainEnforcement}</h3><GuardBadge agent={agent} /></div><div className={"panel-body mc-onchain"}><dl className="kv"><dt>{L.safe}</dt><dd className="addr">{onchain.safe}</dd><dt>{L.rolesModule}</dt><dd className="addr">{onchain.roles}</dd><dt>{L.role}</dt><dd className="mc-rule">{onchain.role}</dd><dt>{L.agentSigner}</dt><dd className="addr">{onchain.signer}</dd><dt>{L.chain}</dt><dd>{onchain.chain}</dd></dl><div><span className="eyebrow">{L.permissionSetPreview}</span><ul className="mc-perms">{onchain.perms.map((p) => <li key={p}><IconCheck />{p}</li>)}</ul><p className="note">{guardLine(agent)} {L.ponsCurveTradesSitOutsideThisRole}</p></div></div></section>}
    {agent.kind === 'perp_venue' && flags.perps_panel && venue && <section className="panel"><div className="panel-head"><h3>{L.venueKey}</h3><span className="tag">{venue.venue}</span></div><div className="panel-body"><p className="mc-p">{venue.note} {L.toCutTheAgentOffAtThe}</p></div></section>}
    <section className={"panel mc-keys-wide"}><div className="panel-head"><h3>{L.scopes}</h3></div><div className="panel-body"><ul className="mc-scopes">{[...new Set(keys.flatMap((k) => k.scopes ?? []))].map((scope) => <li key={scope}><IconCheck /><span className="mc-rule">{scope}</span></li>)}</ul><p className="note">{L.noScopeLetsEkoMoveFundsOr}</p></div></section>
    {agent.status !== 'disconnected' && <section className="panel"><div className="panel-head"><h3>{L.newHarnessKey}</h3></div><div className="panel-body">{secret ? <OneTimeKey secret={secret} dismiss={() => setSecret('')} /> : <button className={"btn btn-sm"} disabled={busy} onClick={() => void issue()}>{L.createAKey}</button>}</div></section>}
    {error && <p role="alert">{error}</p>}
    {revoke && <MissionDialog title={revoke.kind === 'oauth' ? L.revokeOauthGrant : L.revokeHarnessKey} close={busy ? () => {} : () => setRevoke(null)} footer={<><button className={"btn btn-ghost"} disabled={busy} onClick={() => setRevoke(null)}>{L.cancel}</button><button className={"btn btn-danger"} disabled={busy} onClick={() => void remove()}>{L.confirmRevoke}</button></>}><p>{L.thisConnectionWillStopAuthenticatingWithEko}</p>{error && <p role="alert">{error}</p>}</MissionDialog>}
  </div>;
}
