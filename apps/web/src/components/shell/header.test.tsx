import { renderToStaticMarkup as render } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ekoMark from '../../../../landing/src/assets/eko-mark.svg';
import { CHAIN_NAME } from '../../copy/chain';
import type { WsState } from '../../lib/ws';

// Server rendering reads a zustand store's initial state, so the header reads this stand-in instead.
const shell: { wsState: WsState; delayedSec: number; headBlock: number | null; config: { token?: { address: string; symbol?: string } } | null } = { wsState: 'open', delayedSec: 0, headBlock: null, config: null };
const set = (next: Partial<typeof shell>) => Object.assign(shell, next);
vi.mock('../../store/shell', () => ({ useShell: (pick: (s: typeof shell) => unknown) => pick(shell) }));
vi.mock('../../lib/router', async (original) => ({ ...(await original<typeof import('../../lib/router')>()), usePath: () => '/radar' }));
const { Header, MobileBar, streamNotice, CONNECT_GRACE_MS } = await import('./Shell');
const { TokenCa } = await import('./TokenCa');
const status = (html: string) => html.match(/<span role="status"[^>]*>.*?<\/span>/)?.[0] ?? '';

describe('terminal header', () => {
  afterEach(() => set({ wsState: 'open', delayedSec: 0, headBlock: null, config: null }));
  it('shows the token\'s contract address with a copy button once the config has one, and nothing before', () => {
    expect(render(<Header />)).not.toContain('token-ca');
    set({ config: { token: { address: '0xabababababababababababababababababababab', symbol: 'EKO' } } });
    const html = render(<Header />);
    expect(html).toContain('aria-label="Copy $EKO CA: 0xabababababababababababababababababababab"');
    expect(html).toContain('0xabab…abab');
    expect(render(<TokenCa compact />)).toMatch(/class="token-ca compact".*>CA</);
  });
  it('links back to the landing page with its desktop and compact lockups', () => {
    const mark = render(<img src={ekoMark} alt="" />).match(/<img[^>]+>/)?.[0];
    const wordmark = '<span class="eko-brand-text">EKO</span>';
    expect(render(<Header />)).toContain(`<a href="/" class="apphdr-brand eko-header-brand" aria-label="EKO: back to the site">${mark}${wordmark}</a>`);
    expect(render(<MobileBar />)).toContain(`<a href="/" class="apphdr-brand eko-header-brand eko-header-brand--compact" aria-label="EKO: back to the site">${mark}${wordmark}</a>`);
  });
  it('shows only the UTC clock top right while the stream is healthy', () => {
    set({ wsState: 'open', delayedSec: 0, headBlock: 117_014_144 });
    const html = render(<Header />);
    expect(html).toMatch(/<span class="num apphdr-clock" aria-hidden="true">\d\d:\d\d:\d\d UTC<\/span>/);
    expect(html).not.toContain(CHAIN_NAME);
    expect(html).not.toMatch(/Block|117,014,144|live-dot|apphdr-chain/);
    // The status is still there for assistive tech and checks, but not drawn.
    expect(status(html)).toContain('class="sr"');
    expect(status(html)).toContain('data-testid="stream-status"');
    expect(status(html)).toContain('>Live<');
  });
  it('raises a quiet badge when data is delayed or the stream drops', () => {
    set({ wsState: 'open', delayedSec: 45 });
    expect(status(render(<Header />))).toContain('class="apphdr-badge delayed"');
    expect(status(render(<Header />))).toContain('Delayed ~45 s');
    set({ wsState: 'reconnecting', delayedSec: 0 });
    expect(status(render(<Header />))).toMatch(/class="apphdr-badge".*Reconnecting/);
    set({ wsState: 'closed' });
    expect(status(render(<Header />))).toMatch(/class="apphdr-badge".*Offline/);
  });
  it('gives a first connection a grace period before admitting it is still connecting', () => {
    expect(streamNotice('open', 0, 0)).toBeNull();
    expect(streamNotice('open', 30, 0)).toBe('Delayed ~30 s');
    expect(streamNotice('connecting', 0, CONNECT_GRACE_MS - 1)).toBeNull();
    expect(streamNotice('connecting', 0, CONNECT_GRACE_MS)).toBe('Connecting');
    expect(streamNotice('reconnecting', 0, 0)).toBe('Reconnecting');
    expect(streamNotice('closed', 0, 0)).toBe('Offline');
    set({ wsState: 'connecting' });
    expect(status(render(<Header />))).toContain('class="sr"');
  });
});
