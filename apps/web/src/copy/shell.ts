export const APP_NAME = 'EKO';
export const PAGE_TITLES: Record<string, string> = {
  '/': 'Landing', '/radar': 'Radar', '/feed': 'Feed', '/pairs': 'New pairs', '/coin/:address': 'Coin', '/scan': 'Scan', '/scan/:id': 'Scan result',
  '/bags': 'Scan my bags', '/bags/r/:id': 'Bag report', '/watch': 'Watchlist', '/scoreboard': 'Scoreboard', '/deployer/:address': 'Deployer history', '/receipt/:id': 'Receipt verify',
  '/official': 'Official project links', '/transparency': 'Transparency', '/security': 'Security',
  '/census': 'Census', '/drops': 'Drops', '/mission': 'Mission Control', '/mission/agents/:id': 'Agent detail', '/mission/connect': 'Connect an agent',
  '/mission/approvals': 'Approvals', '/approve/:id': 'Approval', '/lab': 'Rule Lab', '/lab/:loopId': 'Rule Lab', '/research': 'Research', '/research/:id': 'Deep Research',
  '/perps': 'Perps', '/swarm': 'Beat the Swarm', '/embed/clear/:address': 'Clear badge',
  '/oauth/consent': 'Connector consent', '/settings': 'Settings', '/settings/plan': 'Plan', '/legal/:doc': 'Legal', '/afi': 'Agent Flow Index', '/embed/afi': 'Agent Flow Index',
  '/crews': 'Rug Ring Radar', '/crews/:id': 'Crew', '/leaderboards': 'Leaderboards', '/arena': 'The Arena', '/desk/:runId': 'Desk',
  '/mission/launcher': 'Agent Launcher', '/inside': 'Inside', '/embed/verdict/:address': 'Verdict widget',
};
export const SHELL_COPY = {
  search: 'Search or paste a CA', scan: 'Scan', more: 'More', skip: 'Skip to content', live: 'Live',
  reconnecting: 'Reconnecting', connecting: 'Connecting', offline: 'Offline', block: 'Block',
  free: 'Free during launch week', tokenLive: 'Tiers start tomorrow', listener: 'Listener',
  preview: 'This screen is being built.', how: 'How it works', skeleton: 'The shell is ready. Data and actions arrive with this screen.',
  notFound: 'Page not found', back: 'Back to Radar', connect: 'Connect and verify your wallet to use this page.',
  wallet: 'Connect wallet', risk: 'Risk mode', open: 'Open the full page', close: 'Close inspector',
  select: 'Inspector preview', inspector: 'Inspector', planDormant: 'Tiers and trials are planned. Free during launch week.',
  configError: 'Configuration unavailable. Optional routes are hidden.', retry: 'Retry',
  connectGate: 'Give your trading agent EKO’s checks before each order, through Claude Code or another MCP client. You supervise it in Mission Control.',
  missionEyebrow: 'Mission Control', missionGate: 'Mission Control is where you connect a trading agent to EKO and review the checks it runs before each order.',
};
/** Display name for a risk mode or preset; the API keeps its `safe` / `Safe` values. */
export const riskModeLabel = (name: string) => ({ safe: 'Careful', Safe: 'Careful', balanced: 'Balanced', degen: 'Degen' } as Record<string, string>)[name] ?? name;
export const RISK_OPTIONS = [{ value: 'safe', label: 'Careful' }, { value: 'balanced', label: 'Balanced' }, { value: 'degen', label: 'Degen' }] as const;

export const REQUEST_PAUSE = (seconds: number) => `Too many requests from this browser. Retrying in ${seconds} s.`;
