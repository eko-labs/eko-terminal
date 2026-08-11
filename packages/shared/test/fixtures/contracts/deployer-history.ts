const untrusted = (text: string) => ({ text, truncated: false, flags: [] });
const launch = {
  address: '0xabababababababababababababababababababab', deployer: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd', relation: 'deployer',
  name: untrusted('Sample'), symbol: untrusted('SMPL'), createdAt: '2026-11-10T12:00:00.000Z', block: 4_000_000, swaps: 42,
  level: 'danger', firstLevel: 'monitor', flags: [{ id: 'dev_dump', level: 'danger' }], outcome1h: 'survived', outcome24h: 'dumped', source: 'live',
};
export const deployerHistorySamples = {
  LaunchOutcome: 'rugged',
  DeployerLaunch: launch,
  DeployerHistory: {
    deployer: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
    funder: { address: '0xefefefefefefefefefefefefefefefefefefefef', fundedAt: '2026-11-09T12:00:00.000Z', hub: false, tx: '0x01' },
    funderStatus: 'traced', crew: { id: '0xefefefefefefefefefefefefefefefefefefefef', deployers: ['0x1212121212121212121212121212121212121212'] },
    summary: { launches: 3, traded: 2, flagged: 1, outcomes: { rugged: 0, honeypot: 0, dumped: 1, survived: 1 }, firstLaunchAt: '2026-11-09T13:00:00.000Z', lastLaunchAt: '2026-11-10T12:00:00.000Z' },
    launches: [launch], coverage: { since: '2026-11-05T00:00:00.000Z', launchesThroughBlock: 4_400_000 },
  },
};
