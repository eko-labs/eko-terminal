import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '../mocks/responses';
import { resolveRoute } from '../routes';
import { useShell } from '../store/shell';
import Drops from './Drops';

// SSR uses Zustand's initial snapshot; exercise current client state explicitly.
vi.mock('../store/shell', async importOriginal => {
  const actual = await importOriginal<typeof import('../store/shell')>();
  return { useShell: Object.assign((selector: (state: ReturnType<typeof actual.useShell.getState>) => unknown) => selector(actual.useShell.getState()), actual.useShell) };
});

const entry = {
  n: 3, date: '2026-11-10', title: 'Sample paper demo', status: 'demo' as const, requiredFlags: ['arena' as const],
  demo: { videoUrl: '/demos/drops/sample-paper.mp4', recordedAt: '2026-10-01T00:00:00Z' },
};
const original = useShell.getState();
afterEach(() => useShell.setState(original));
const render = () => renderToStaticMarkup(<Drops />);

describe('public Drops page', () => {
  it('loads the real public T page with no flags or wallet', async () => {
    const route = resolveRoute('/drops')!.route;
    expect(route).toMatchObject({ auth: 'public', stage: 'T' });
    expect((await route.load()).default).toBe(Drops);
  });
  it('distinguishes loading, config failure and the valid empty manifest', () => {
    useShell.setState({ config: null, configError: null });
    expect(render()).toContain('Loading Drops…');
    useShell.setState({ configError: 'sample-error' });
    expect(render()).toContain('Drops are unavailable');
    useShell.setState({ config: createConfig(), configError: null });
    expect(render()).toContain('No recorded Drop demos yet');
    expect(render()).not.toContain('<video');
  });
  it('renders qualified targets and same-origin videos, omitting hidden and undemoed records', () => {
    const config = createConfig();
    config.drops = [entry, { ...entry, title: 'Hidden sample', status: 'hidden' }, { ...entry, title: 'Undemoed sample', demo: undefined }];
    useShell.setState({ config });
    const html = render();
    expect(html).toContain('Built and demoed · shipping in Drop 3 (target');
    expect(html).toContain('<time dateTime="2026-11-10">Nov 10, 2026</time>');
    expect(html).toContain('<video controls="" playsInline="" preload="none" src="/demos/drops/sample-paper.mp4"');
    expect(html).not.toContain('Hidden sample');
    expect(html).not.toContain('Undemoed sample');
  });
  it('refuses live wording unless the manifest and flags agree on an already published release', () => {
    const config = createConfig();
    config.flags.arena = true;
    config.drops = [{ ...entry, status: 'live' }];
    useShell.setState({ config });
    expect(render()).not.toContain('<p>Live</p>');
    config.drops[0].release = { version: 'sample-v1', publishedAt: '2026-10-01T00:00:00Z', url: 'https://example.invalid/releases/sample-v1' };
    expect(render()).toContain('<p>Live</p>');
    expect(render()).toContain('Published release: sample-v1');
    config.flags.arena = false;
    expect(render()).not.toContain('<p>Live</p>');
    expect(render()).not.toContain('Published release:');
  });
  it('omits remote videos and escapes titles', () => {
    const config = createConfig();
    config.drops = [{ ...entry, title: '<script>sample</script>' }, { ...entry, demo: { ...entry.demo, videoUrl: 'https://example.invalid/demo.mp4' } }];
    useShell.setState({ config });
    const html = render();
    expect(html).toContain('&lt;script&gt;sample&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('https://example.invalid/demo.mp4');
  });
});
