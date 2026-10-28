import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { initializePwa, installPwa, registerPwa, usePwa } from './pwa';
import { createApi } from './api';
import { setApiUnavailable } from './connection';
import { ConnectionStatus, InstallSettings } from '../components/Pwa';
import { PWA_COPY as C } from '../copy/pwa';

// Read live external-store snapshots without a browser or an additional renderer.
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock('./pwa', async original => {
  const actual = await original<typeof import('./pwa')>();
  return { ...actual, usePwa: Object.assign(() => actual.usePwa.getState(), actual.usePwa) };
});
let target: EventTarget;
let register: ReturnType<typeof vi.fn>;
beforeEach(() => {
  target = new EventTarget(); register = vi.fn().mockResolvedValue({});
  vi.stubGlobal('window', Object.assign(target, { matchMedia: () => ({ matches: false }) }));
  vi.stubGlobal('location', { pathname: '/radar' });
  vi.stubGlobal('navigator', { onLine: true, serviceWorker: { register } });
  vi.stubEnv('PROD', true);
  usePwa.setState({ prompt: null, installed: false, failed: false }); setApiUnavailable(false);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('PWA install and connection UI (fixtures)', () => {
  it('registers the production worker without requesting push or prompting on arrival', async () => {
    initializePwa();
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn().mockResolvedValue(undefined), userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); expect(event.prompt).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<InstallSettings />)).toContain(C.install);
    await installPwa(); await installPwa(); expect(event.prompt).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event('appinstalled'));
    expect(renderToStaticMarkup(<InstallSettings />)).toContain(C.installed);
    expect(usePwa.getState().prompt).toBeNull();
  });
  it('defers the terminal precache until entry from the landing and registers once', () => {
    vi.stubGlobal('location', { pathname: '/scan' }); initializePwa();
    expect(register).not.toHaveBeenCalled();
    registerPwa(); registerPwa();
    expect(register).toHaveBeenCalledTimes(1);
  });
  it('keeps development unregistered and supports manual iOS and standalone installation', () => {
    vi.stubEnv('PROD', false); initializePwa(); expect(register).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<InstallSettings />)).toContain(C.ios);
    Object.assign(window, { matchMedia: () => ({ matches: true }) }); initializePwa();
    expect(renderToStaticMarkup(<InstallSettings />)).toContain(C.installed);
  });
  it('consumes dismissed and rejected prompts without automatic retry', async () => {
    initializePwa();
    for (const outcome of ['dismissed', 'error']) {
      const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt: outcome === 'error' ? vi.fn().mockRejectedValue(new Error('Unavailable')) : vi.fn().mockResolvedValue(undefined),
        userChoice: Promise.resolve({ outcome: 'dismissed' as const }),
      });
      target.dispatchEvent(event); await installPwa();
      expect(usePwa.getState().prompt).toBeNull(); expect(usePwa.getState().installed).toBe(false);
      expect(usePwa.getState().failed).toBe(outcome === 'error');
    }
  });
  it('renders offline and missing API messages and clears them on recovery; aborted requests do not signal failure', async () => {
    expect(renderToStaticMarkup(<ConnectionStatus />)).toBe('');
    vi.stubGlobal('navigator', { onLine: false });
    expect(renderToStaticMarkup(<ConnectionStatus />)).toContain('You&#x27;re offline. Approvals need a connection.');
    vi.stubGlobal('navigator', { onLine: true });
    await expect(createApi('/v1', async () => { throw new Error('Offline'); }).request('/me')).rejects.toMatchObject({ status: 0 });
    expect(renderToStaticMarkup(<ConnectionStatus />)).toContain(C.unavailable);
    const transport = vi.fn().mockResolvedValue(new Response('{}'));
    await createApi('/v1', transport).request('/me');
    expect(transport).toHaveBeenCalledWith('/v1/me', expect.objectContaining({ cache: 'no-store' }));
    expect(renderToStaticMarkup(<ConnectionStatus />)).toBe('');
    await expect(createApi('/v1', async () => { throw new DOMException('Cancelled', 'AbortError'); }).request('/me')).rejects.toMatchObject({ name: 'AbortError' });
    expect(renderToStaticMarkup(<ConnectionStatus />)).toBe('');
    await createApi('/v1', async () => new Response('{}', { status: 503 })).request('/config').catch(() => undefined);
    expect(renderToStaticMarkup(<ConnectionStatus />)).toContain(C.unavailable);
  });
  it('keeps the connection banner off when a reachable server answers 5xx with a product state', async () => {
    await expect(createApi('/v1', async () => new Response(JSON.stringify({ error: 'sim_unavailable', message: 'Actual-account trade acquisition is unavailable' }), { status: 503 })).request('/trade/quote', { body: {} }))
      .rejects.toMatchObject({ status: 503, code: 'sim_unavailable' });
    expect(renderToStaticMarkup(<ConnectionStatus />)).toBe('');
    await createApi('/v1', async () => new Response(JSON.stringify({ error: 'internal_error', message: 'Failed' }), { status: 500 })).request('/config').catch(() => undefined);
    expect(renderToStaticMarkup(<ConnectionStatus />)).toContain(C.unavailable);
  });
});
