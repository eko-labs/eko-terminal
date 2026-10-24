import { RateNotice } from './components/RateNotice';
import { Suspense, lazy, useEffect, useRef } from 'react';
import { useWalletState } from './lib/walletState';
import { z } from 'zod';
import { FeedItemSchema, ApprovalSchema, MeSchema, PublicConfigSchema } from '@eko/shared';
import { Header, Sidebar, MobileBar, MobileTabs } from './components/shell/Shell';
import { RealtimeContext } from './lib/RealtimeContext';
import { Onboarding } from './components/onboarding/Onboarding';
import { WatchRuntime } from './components/WatchButton';
import { AlertsDrawer } from './components/shell/AlertsDrawer';
import { Toasts } from './components/Shell';
import { CommandPalette, ShortcutsHelp, useShortcuts } from './components/Command';
import { fetchParsed, isRateLimited, MOCKS } from './lib/api';
import { Link } from './lib/Link';
import { usePath } from './lib/router';
import { createRealtime, type Realtime } from './lib/realtime';
import { flushPendingReports } from './lib/pendingReports';
import { ROUTES, INTERNAL_ROUTES, resolveRoute } from './routes';
import { useApp } from './store/app';
import { useShell } from './store/shell';
import { useUi } from './store/ui';
import { SHELL_COPY as C } from './copy/shell';
import { DYOR, NON_AFFILIATION } from './copy';
import { trackEvent } from './lib/telemetry';
import { captureReferral } from './lib/referral';
import { SkipLink } from './components/SkipLink';
import { useShareMeta } from './lib/share';

const pages = new Map([...ROUTES, ...INTERNAL_ROUTES].map((route) => [route, lazy(route.load)]));
/** Wallet-gated Mission Control pages still say what they are before asking for a wallet. */
function GatedHead({ title, intro }: { title: string; intro: string }) { return <div className="shell-page gated-head"><div className="page-head"><span className="eyebrow">{C.missionEyebrow}</span><h1>{title}</h1><p>{intro}</p></div></div>; }
export function NotFound() { return <div className="shell-page"><div className="page-head"><h1>{C.notFound}</h1></div><Link to="/radar" className="btn">{C.back}</Link></div>; }
async function loadConfig(signal?: AbortSignal) {
  try { const config = await fetchParsed('/config', PublicConfigSchema, { signal }); useShell.setState({ config, configError: null }); }
  catch (err) { if ((err as Error).name !== 'AbortError' && !isRateLimited(err)) useShell.setState({ configError: (err as Error).message }); }
}
const WalletRuntime = lazy(() => import('./WalletRuntime'));
export function App({ walletEnabled = false }: { walletEnabled?: boolean }) {
  const density = useUi(s => s.density);
  const path = usePath(), config = useShell((s) => s.config), error = useShell((s) => s.configError);
  const account = useApp((s) => s.account), connection = useWalletState();
  const signedIn = account?.kind === 'wallet' && !!connection.address && account.walletAddress === connection.address.toLowerCase();
  const realtime = useRef<Realtime | null>(null);
  const signedInRef = useRef(signedIn); signedInRef.current = signedIn;
  useShortcuts();
  useEffect(() => { trackEvent({ name: 'page_view' }); }, [path]);
  useEffect(() => {
    captureReferral();
    const controller = new AbortController(); let client: Realtime | null = null;
    void loadConfig(controller.signal);
    void useApp.getState().refreshSession().catch(() => undefined);
    void createRealtime().then((rt) => {
      if (controller.signal.aborted) { rt.close(); return; }
      client = rt; realtime.current = rt; useShell.setState({ realtime: rt });
      rt.onState((wsState) => { useShell.setState({ wsState }); if (wsState === 'open') void flushPendingReports(); });
      rt.onControl((message) => { if (message.t === 'hello') useShell.setState({ delayedSec: message.delayedSec }); });
      const resyncFeed = async () => {
        const snapshot = await fetchParsed('/feed', z.object({ rows: z.array(FeedItemSchema) }));
        useShell.setState({ headBlock: snapshot.rows.reduce((head, row) => Math.max(head, row.block), 0) || null });
      };
      rt.subscribeBatch('feed', (events) => useShell.setState((s) => ({ headBlock: Math.max(s.headBlock ?? 0, ...events.map((event) => event.data.block)) })), resyncFeed);
      rt.subscribeBatch('alerts', (events) => {
        const event = events.findLast((event) => event.kind === 'entitlements');
        const me = useShell.getState().me;
        if (event?.kind === 'entitlements' && me) useShell.setState({ me: { ...me, entitlements: event.data } });
      });
      rt.setSignedIn(signedInRef.current || MOCKS); rt.connect();
    });
    return () => { controller.abort(); client?.close(); realtime.current = null; useShell.setState({ realtime: null }); };
  }, []);
  useEffect(() => {
    realtime.current?.setSignedIn(signedIn || MOCKS);
    if (!signedIn) { useShell.setState({ me: null, approvalIds: [] }); return; }
    const controller = new AbortController();
    void fetchParsed('/me', MeSchema, { signal: controller.signal }).then((me) => useShell.setState({ me })).catch(() => undefined);
    return () => controller.abort();
  }, [signedIn, account?.walletAddress]);
  const sharedRealtime = useShell((s) => s.realtime);
  useEffect(() => {
    if (!sharedRealtime || !config?.flags.approvals) { useShell.setState({ approvalIds: [] }); return; }
    const resync = async () => {
      const snapshot = await fetchParsed('/approvals?status=pending', z.object({ rows: z.array(ApprovalSchema) }));
      useShell.setState({ approvalIds: snapshot.rows.filter((a) => a.status === 'pending').map((a) => a.id) });
    };
    if (signedIn || MOCKS) void resync().catch(() => undefined);
    return sharedRealtime.subscribeBatch('approvals', (events) => {
      const ids = new Set(useShell.getState().approvalIds);
      for (const event of events) { if (event.data.status === 'pending') ids.add(event.data.id); else ids.delete(event.data.id); }
      useShell.setState({ approvalIds: [...ids] });
    }, resync);
  }, [sharedRealtime, config?.flags.approvals, signedIn]);
  const resolved = resolveRoute(path, config?.flags);
  const Page = resolved ? pages.get(resolved.route)! : null;
  // The title follows the resolved route, which can change after /config loads its flags; focus moves only on navigation.
  const pageTitle = resolved?.route.title ?? C.notFound;
  useShareMeta(path, pageTitle);
  const gatedMission = !!resolved && resolved.route.workspace === 'mission' && resolved.route.auth === 'siwe' && !signedIn && !MOCKS && (path.startsWith('/mission/agents/') || path === '/mission/approvals' || path.startsWith('/approve/'));
  // Connect stays readable signed out: its steps are the pitch; only creating the agent or key needs a wallet. The
  // page carries its own heading and intro, so no gate heading is added above it (it showed "Connect an agent" twice).
  const page = Page && resolved ? <>{gatedMission ? <GatedHead title={pageTitle} intro={C.missionGate} /> : <Page params={resolved.params} />}{resolved.route.auth === 'siwe' && path !== '/bags' && path !== '/watch' && !signedIn && !(MOCKS && resolved.route.workspace === 'mission') ? <div className="connect-card"><p>{C.connect}</p><button className="btn" onClick={() => window.dispatchEvent(new Event('eko:open-wallet'))}>{C.wallet}</button></div> : null}
    {['/scan/', '/bags/r/', '/receipt/'].some(prefix => path.startsWith(prefix)) && <div className="shell-note"><p>{DYOR}</p><p>{NON_AFFILIATION}</p></div>}
  </> : <NotFound />;
  return <RealtimeContext.Provider value={sharedRealtime}><WatchRuntime owner={MOCKS ? 'demo-account' : signedIn ? account!.walletAddress : null} /><AlertsDrawer /><div className="eko-shell" data-style="desk" data-density={density}><SkipLink /><Header /><div className="shell-frame"><Sidebar /><MobileBar /><main className="shell-main" id="main" tabIndex={-1}><RateNotice />
    {error && <div className="shell-error" role="status">{C.configError} <button className="btn" onClick={() => void loadConfig()}>{C.retry}</button></div>}
    <Suspense fallback={<div className="shell-page"><div className="skel" style={{ height: 200 }} /></div>}>
      {walletEnabled ? <WalletRuntime>{page}</WalletRuntime> : page}
    </Suspense>
  </main></div><MobileTabs /><Onboarding /><CommandPalette /><ShortcutsHelp /><Toasts /></div></RealtimeContext.Provider>;
}
