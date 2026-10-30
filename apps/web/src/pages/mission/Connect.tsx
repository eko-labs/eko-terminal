import { riskModeLabel } from '../../copy/shell';
import { MISSION_LABELS as L, MISSION_TEXT as T, CONNECT_STEPS as STEPS } from '../../copy/mission';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { UnsignedTxSchema, type AgentDetail, type Flags, type Pack } from '@eko/shared';
import { fetchParsed } from '../../lib/api';
import { connectionReceived, createAgent, createKey, fillPack, loadPacks, loadPresets, packAvailable, type PresetsResponse } from '../../lib/mission';
import { useOnboarding } from '../../store/onboarding';
import { useShell } from '../../store/shell';
import { useApp } from '../../store/app';
import { JournalConsentSetting } from '../settings/JournalConsent';
import { Link } from '../../lib/Link';
import { IconShield, IconArrow, IconCheck } from '../../components/icons';
import { ADVISORY, BUILT_ON, NON_AFFILIATION, ONCHAIN_ADVISORY } from '../../copy';
import { MISSION_COPY as C, PLATFORM_COPY } from '../../copy/mission';
import { money } from './parts';
import { OneTimeKey } from './OneTimeKey';
import './mission.css';
import './mission-screens.css';
import './connect.css';

type Platform = Pack['platform'] | 'onchain';
const oauth = (platform: Platform) => ['claude_connector', 'chatgpt'].includes(platform);
export function PackCards({ packs, flags, phase, selected, select }: { packs: Pack[]; flags: Partial<Flags>; phase: 'launch_week' | 'token_live' | 'tiers'; selected: Platform; select: (p: Platform) => void }) {
  const available: Platform[] = packs.filter((p) => packAvailable(p, flags, phase)).map((p) => p.platform);
  if (flags.onchain_guardrails && phase !== 'launch_week' && available.includes('generic_mcp')) available.push('onchain');
  return <div className="cn-clients" role="radiogroup" aria-label={L.yourAgentSClient}>{available.map((platform) => <button key={platform} className="cn-client" role="radio" aria-checked={selected === platform} onClick={() => select(platform)}><span className="cn-client-name">{PLATFORM_COPY[platform][0]}</span><span className="cn-client-line">{PLATFORM_COPY[platform][1]}</span><span className="cn-mode">{platform === 'onchain' ? L.guardrailsEnforcedOnceReviewed : L.advisoryGuardrails}</span><span className="cn-client-foot"><span className="tag">{packs.find((p) => p.platform === platform)?.stage === "T" ? L.harnessPreview : L.shipsAtTokenLaunch}</span></span></button>)}</div>;
}
function CodeBlock({ label, code, copy }: { label: string; code: string; copy?: () => string }) {
  const [message, setMessage] = useState('');
  return <div className="cn-code"><div className="cn-code-head"><b>{label}</b><button className="btn btn-sm btn-ghost" onClick={() => { void navigator.clipboard.writeText(copy ? copy() : code).then(() => setMessage(L.copied)).catch(() => setMessage(L.couldNotCopyCheckClipboardPermissions)); }}>{L.copy}</button></div><pre className="mc-code">{code}</pre>{message && <p role="status">{message}</p>}</div>;
}
// TODO(spec): Pack.platform has no on-chain member. The flagged session-key path
// uses the generic MCP pack for its config and instructions; no invented endpoint/snippet.
export function ConnectScreen({ packs, presets, flags, phase }: { packs: Pack[]; presets: z.infer<typeof PresetsResponse>; flags: Partial<Flags>; phase: 'launch_week' | 'token_live' | 'tiers' }) {
  const available = packs.filter((p) => packAvailable(p, flags, phase)), rt = useShell((s) => s.realtime);
  // Signed-out visitors can read every step; only creating the agent, its key or a session needs a verified wallet.
  const signedIn = useShell((s) => !!s.me);
  const owner = useApp((s) => s.account?.kind === 'wallet' ? s.account.id : null);
  const [selection, setSelected] = useState<Platform>(available[0]?.platform ?? 'claude_code'), [name, setName] = useState(''), [preset, setPreset] = useState<string>(L.balanced), [agent, setAgent] = useState<AgentDetail | null>(null), [visibleKey, setVisibleKey] = useState(''), [keyIssued, setKeyIssued] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [waiting, setWaiting] = useState(false), [connected, setConnected] = useState(false), [sessionConfirmed, setSessionConfirmed] = useState(false);
  const selected = selection === 'onchain' && flags.onchain_guardrails && phase !== 'launch_week' || available.some((p) => p.platform === selection) ? selection : available[0]?.platform ?? 'claude_code';
  const key = useRef(''), mounted = useRef(true), generation = useRef(0);
  const pack = available.find((p) => p.platform === (selected === 'onchain' ? 'generic_mcp' : selected)), p = presets.find((p) => p.name === preset)?.policy;
  const agentName = name.trim() || T.defaultAgent(PLATFORM_COPY[selected][0].split(' ')[0]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; key.current = ''; generation.current++; }; }, []);
  useEffect(() => {
    if (!agent || connected) return;
    const controller = new AbortController(), run = generation.current;
    let pending = false;
    const check = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      const onboardingOwner = useOnboarding.getState().owner;
      try {
        const received = await connectionReceived(agent.id, controller.signal);
        if (!controller.signal.aborted && mounted.current && generation.current === run && received) {
          if (useOnboarding.getState().owner === onboardingOwner) useOnboarding.getState().markStep('connect_agent');
          setConnected(true); setWaiting(false); key.current = ''; setVisibleKey('');
        }
      } catch (error) {
        if (!controller.signal.aborted && mounted.current && generation.current === run) setError((error as Error).message);
      } finally { pending = false; }
    };
    const unsubscribe = rt?.subscribe('agents', (e) => {
      if ((e.kind === 'preflight' && e.data.agentId === agent.id) || (e.kind === 'agent' && e.data.id === agent.id)) void check();
    }, check);
    const timer = waiting ? setInterval(() => void check(), 3000) : undefined;
    if (waiting) void check();
    return () => { controller.abort(); unsubscribe?.(); if (timer) clearInterval(timer); };
  }, [rt, agent?.id, waiting, connected]);
  const select = (platform: Platform) => { if (busy) return; generation.current++; key.current = ''; setVisibleKey(''); setKeyIssued(false); setAgent(null); setError(''); setWaiting(false); setConnected(false); setSessionConfirmed(false); setSelected(platform); };
  const ensureAgent = async () => {
    if (agent) return agent;
    const a = await createAgent(agentName, selected === 'onchain' ? 'onchain' : 'robinhood_mcp', preset.toLowerCase());
    if (mounted.current) setAgent(a); return a;
  };
  const issue = async () => {
    if (busy || keyIssued || oauth(selected)) return; setBusy(true); setError(''); const run = generation.current;
    try { const a = await ensureAgent(); if (!mounted.current) return; const k = await createKey(a.id); if (mounted.current && generation.current === run) { key.current = k.secret; setVisibleKey(k.secret); setKeyIssued(true); } } catch (e) { if (mounted.current) setError((e as Error).message); } finally { if (mounted.current) setBusy(false); }
  };
  const create = async () => { if (busy) return; setBusy(true); setError(''); try { await ensureAgent(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const session = async () => {
    if (!flags.onchain_guardrails || busy) return; setBusy(true); setError('');
    try {
      const a = await ensureAgent(), { tx } = await fetchParsed(`/agents/${encodeURIComponent(a.id)}/session-key`, z.object({ tx: UnsignedTxSchema }), { body: {} });
      const [{ sendTransaction, waitForTransactionReceipt }, { wagmiConfig, walletChainId }] = await Promise.all([import('wagmi/actions'), import('../../lib/wallet')]);
      const chainId = walletChainId(tx.chainId);
      const hash = await sendTransaction(wagmiConfig, { ...tx, value: BigInt(tx.value), chainId }), receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId });
      if (receipt.status !== 'success') throw new Error(L.sessionKeyTransactionRevertedNoConnectionConfirmed);
      setSessionConfirmed(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const verify = async () => {
    if (busy) return; setBusy(true); setError(''); setVisibleKey('');
    try { const a = await ensureAgent(), received = await connectionReceived(a.id); setWaiting(!received); setConnected(received); if (received) key.current = ''; }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (!pack) return <div className="page"><h1>{L.connectAnAgent}</h1><p>{L.noInstallPacksAreAvailableYet}</p></div>;
  const setup = pack.setup?.split('\n') ?? [];
  const config = <CodeBlock label={oauth(selected) ? L.connectorUrl : L.mcpConfig} code={fillPack(pack.configTemplate, keyIssued ? '••••••••••••••••' : '<YOUR_KEY>')} copy={() => fillPack(pack.configTemplate, key.current || '<YOUR_KEY>')} />;
  const instructions = <CodeBlock label={L.harnessInstructions} code={pack.instructions} />;
  const keyControl = visibleKey ? <OneTimeKey secret={visibleKey} dismiss={() => setVisibleKey('')} /> : keyIssued ? <p className="note">{L.keyShownOnceItCanTBe}</p> : <button className="btn" disabled={busy || !signedIn} title={signedIn ? undefined : C.connectToCreate} onClick={() => void issue()}>{busy ? L.generating : L.generateKey}</button>;
  const steps: { title: string; description: ReactNode; content?: ReactNode }[] = oauth(selected) ? [
    { title: selected === 'claude_connector' ? STEPS.connector[0] : setup[0] ?? L.install, description: setup[0] },
    { title: STEPS.connector[1], description: setup[1], content: config },
    { title: STEPS.connector[2], description: setup[2], content: <div className="cn-consent"><div className="cn-consent-body"><b className="cn-consent-title">{agentName} · {riskModeLabel(preset)}</b><p className="note">{L.addTheConnectorSignInWithThe}</p>{agent ? <span className="tag">{L.agentCreatedPolicyV}{agent.policy.version}</span> : <button className="btn" disabled={busy || !signedIn} title={signedIn ? undefined : C.connectToCreate} onClick={() => void create()}>{busy ? L.creating : L.createAgent}</button>}</div></div> },
    { title: STEPS.connector[3], description: STEPS.connectorReturn, content: <>{instructions}<p className="cn-note">{ADVISORY}</p><p className="lab-foot">{BUILT_ON}. {NON_AFFILIATION}</p></> },
  ] : [
    { title: STEPS.key[0], description: L.theKeyTiesThisAgentToIts, content: keyControl },
    { title: STEPS.key[1], description: setup[0] ?? STEPS.keyConfig, content: <>{config}{selected === 'onchain' && flags.onchain_guardrails && <div className="cn-el"><p>{ONCHAIN_ADVISORY}</p><button className="btn" disabled={busy || sessionConfirmed || !signedIn} title={signedIn ? undefined : C.connectToCreate} onClick={() => void session()}>{sessionConfirmed ? L.sessionKeyTransactionConfirmed : L.reviewAndSignSessionKeyPolicy}</button></div>}</> },
    { title: STEPS.key[2], description: setup[1], content: instructions },
    { title: STEPS.key[3], description: setup[2] ? `${setup[2]} ${STEPS.keyCheckBelow}` : STEPS.keyCheck, content: <>{owner && <JournalConsentSetting owner={owner} />}<p className="cn-note">{ADVISORY}</p><p className="lab-foot">{BUILT_ON}. {NON_AFFILIATION}</p></> },
  ];
  steps.push({ title: STEPS.approvals, description: ADVISORY });
  return <div className="page mission-screen"><div className="page-head"><div><h1>{L.connectAnAgent}</h1><p>{C.connectIntro}</p></div><Link className="btn cn-head-link" to="/mission">{L.missionControl}<IconArrow /></Link></div><div className="cn-assure"><IconShield /><div><p><b>{C.credentials}</b></p><p>{ADVISORY}</p></div></div><p className="lab-foot">{BUILT_ON}. {NON_AFFILIATION}</p>
    <PackCards packs={packs} flags={flags} phase={phase} selected={selected} select={select} />
    <div className="cn-grid"><div className="cn-main"><section className="panel"><div className="panel-head"><h2>{L.setUp}{' '}{PLATFORM_COPY[selected][0]}</h2><span className="muted">{oauth(selected) ? L.oauthSignInNoKey : L.harnessApiKey} {L.about}{' '}{selected === 'generic_mcp' || selected === 'claude_desktop' || selected === 'onchain' ? '5' : '2'} {L.minutes}</span></div><div className="panel-body"><ol className="cn-steps">
      {steps.map((step, i) => <li key={`${selected}-${i}`}><span className="cn-n num">{i + 1}</span><div className="cn-step"><b>{step.title}</b><p>{step.description}</p>{step.content && <div className="cn-el">{step.content}</div>}</div></li>)}
    </ol>{selected === 'claude_connector' && <p className="cn-note">{C.connectorNote}</p>}</div></section><section className="panel cn-test"><div className="panel-head"><h2>{L.testTheConnection}</h2>{connected && <span className="tag">{L.connected}</span>}</div><div className="panel-body"><p>{connected ? C.connected : waiting ? C.pendingVerify : L.weLlWaitForYourAgentS}</p><div className="cn-test-go"><button className="btn btn-primary btn-lg" disabled={busy || !signedIn || (!oauth(selected) && !keyIssued)} title={signedIn ? undefined : C.connectToCreate} onClick={() => void verify()}>{L.testTheConnection}</button>{!keyIssued && !oauth(selected) && <span className="note">{L.generateAKeyFirst}</span>}{agent && <Link className="btn btn-ghost" to={`/mission/agents/${agent.id}?tab=journal`}>{L.openJournal}</Link>}</div></div></section>{error && <p role="alert">{error}</p>}</div>
    <aside className="cn-aside"><section className="panel"><div className="panel-head"><h3>{L.newAgent}</h3><span className="muted">{L.appliedWhenItSCreated}</span></div><div className="panel-body cn-agent"><label className="field"><span className="label">{L.name}</span><input className="input" value={name} disabled={!!agent || busy} maxLength={40} placeholder={agentName} onChange={(e) => setName(e.target.value)} /></label><div className="field"><span className="label">{L.policyPreset}</span><div className="cn-presets" role="radiogroup" aria-label={L.policyPreset}>{presets.map(({ name, policy }) => <button key={name} className="cn-preset" role="radio" disabled={!!agent || busy} aria-checked={preset === name} onClick={() => setPreset(name)}><b>{riskModeLabel(name)}</b><span>{L.upTo}{' '}{policy.maxPositionUsd === undefined ? '—' : money(policy.maxPositionUsd)} {L.perOrder}</span></button>)}</div></div>{p && <dl className="kv"><dt>{L.maxPosition}</dt><dd>{p.maxPositionUsd === undefined ? '—' : money(p.maxPositionUsd)}</dd><dt>{L.stopAfterADailyLossOf}</dt><dd>{p.maxDailyLossUsd === undefined ? '—' : money(p.maxDailyLossUsd)}</dd><dt>{L.blocksCoinsFlagged}</dt><dd>{p.blockPlaybookLevel === 'monitor' ? L.monitorAndDanger : L.danger}</dd><dt>{L.maxRoundTripCost}</dt><dd>{p.maxRoundTripCostPct}%</dd><dt>{L.minLiquidity}</dt><dd>{money(p.minLiquidityUsd ?? 0)}</dd><dt>{flags.approvals ? L.needsApprovalAbove : L.deniedAboveApprovalLimit}</dt><dd>{p.approvalAboveUsd === undefined ? '—' : money(p.approvalAboveUsd)}</dd></dl>}<p className="note">{L.approvalsArriveAtTokenLaunchUntilThen}</p></div></section><section className="panel"><div className="panel-head"><h3>{L.whatYourAgentGets}</h3><span className="muted">{L.mcpTools}</span></div><div className="panel-body cn-tools">{[[L.senses, ['coin_verdict', 'coin_card', 'playbook_match']], [L.guardrails, ['preflight', ...(flags.approvals ? ['request_approval'] : [])]], [L.flightRecorder, ['journal', ...(flags.unchecked_orders ? ['recall'] : [])]]].map(([group, tools]) => <div className="cn-tool-group" key={String(group)}><span className="eyebrow">{group}</span><ul>{(tools as string[]).map((tool) => <li key={tool}><code>{tool}</code></li>)}</ul></div>)}</div></section></aside></div><p className="lab-foot">{NON_AFFILIATION} {L.preflightIsARiskCheckAgainstYour}</p>
  </div>;
}
export default function Connect() {
  const config = useShell((s) => s.config), [packs, setPacks] = useState<Pack[]>([]), [presets, setPresets] = useState<z.infer<typeof PresetsResponse>>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => { const c = new AbortController(); void Promise.all([loadPacks(c.signal), loadPresets(c.signal)]).then(([packs, presets]) => { if (!c.signal.aborted) { setPacks(packs); setPresets(presets); setLoading(false); } }).catch((e: Error) => { if (e.name !== L.aborterror) { setError(e.message); setLoading(false); } }); return () => c.abort(); }, []);
  if (error) return <div className="page"><p role="alert">{error}</p><button className="btn" onClick={() => location.reload()}>{L.retry}</button></div>;
  if (loading || !config) return <div className="page"><div className="skel" style={{ height: 240 }} role="status" aria-label={L.loadingPacks} /></div>;
  return <ConnectScreen packs={packs} presets={presets} flags={config.flags} phase={config.phase} />;
}
