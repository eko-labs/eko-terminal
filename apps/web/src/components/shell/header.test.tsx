import { renderToStaticMarkup as render } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CHAIN_NAME, CHAIN_TITLE } from '../../copy/chain';

vi.mock('../../lib/router', async (original) => ({ ...(await original<typeof import('../../lib/router')>()), usePath: () => '/radar' }));
const { Header } = await import('./Shell');

describe('terminal header', () => {
  it('names the chain ahead of the live status and block', () => {
    const html = render(<Header />);
    expect(html).toContain(`<span class="apphdr-chain" title="${CHAIN_TITLE}">${CHAIN_NAME}</span>`);
    expect(html.indexOf(CHAIN_NAME)).toBeLessThan(html.indexOf('apphdr-status'));
  });
});
