import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadSdn } from '../src/sanctions/service.js';
afterEach(() => vi.unstubAllGlobals());
const source = 'https://ofac.treasury.gov/fixture.xml';
function stream(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const read = vi.fn(async () => chunks.length ? { done: false, value: chunks.shift()! } : { done: true });
  const cancel = vi.fn(async () => {});
  const fetch = vi.fn(async () => ({ status: 200, headers: new Headers(headers), body: { getReader: () => ({ read, cancel }) } }));
  vi.stubGlobal('fetch', fetch);
  return { fetch, read, cancel };
}
describe('bounded sanctions downloader', () => {
  it('decodes chunked UTF-8, sends no credentials and never lets fetch follow redirects itself', async () => {
    const bytes = new TextEncoder().encode('<fixture>€</fixture>');
    const f = stream([bytes.slice(0, 10), bytes.slice(10)]);
    expect(await downloadSdn(source)).toBe('<fixture>€</fixture>');
    expect(f.fetch).toHaveBeenCalledWith(new URL(source), { redirect: 'manual', signal: expect.any(AbortSignal), headers: { accept: 'application/xml, text/xml' } });
    expect(f.cancel).toHaveBeenCalledOnce();
  });
  it('follows Treasury redirects to the signed published-file link and nowhere else', async () => {
    const sls = 'https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.xml';
    const signed = 'https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/Published/day/SDN.XML?X-Amz-Signature=fixture';
    const redirect = (location?: string) => ({ status: 302, headers: new Headers(location ? { location } : {}), body: null });
    const read = vi.fn(async () => ({ done: true }));
    const ok = { status: 200, headers: new Headers(), body: { getReader: () => ({ read, cancel: vi.fn(async () => {}) }) } };
    const fetch = vi.fn().mockResolvedValueOnce(redirect(sls)).mockResolvedValueOnce(redirect(signed)).mockResolvedValueOnce(ok);
    vi.stubGlobal('fetch', fetch);
    expect(await downloadSdn('https://www.treasury.gov/ofac/downloads/sdn.xml')).toBe('');
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://www.treasury.gov/ofac/downloads/sdn.xml', sls, signed]);
    expect(fetch.mock.calls.every(([, init]) => init.redirect === 'manual')).toBe(true);

    for (const location of ['https://untrusted.example/sdn.xml', 'http://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/SDN.XML',
      'https://other-bucket.s3.us-gov-west-1.amazonaws.com/SDN.XML', 'https://sample-user:placeholder@ofac.treasury.gov/sdn.xml']) {
      fetch.mockReset().mockResolvedValueOnce(redirect(location));
      await expect(downloadSdn(source)).rejects.toThrow('Invalid source');
      expect(fetch).toHaveBeenCalledOnce();
    }
    fetch.mockReset().mockResolvedValueOnce(redirect());
    await expect(downloadSdn(source)).rejects.toThrow('Source unavailable');
    fetch.mockReset().mockResolvedValue(redirect(source));
    await expect(downloadSdn(source)).rejects.toThrow('Source unavailable');
    expect(fetch).toHaveBeenCalledTimes(4);
    fetch.mockReset();
    await expect(downloadSdn(signed)).rejects.toThrow('Invalid source');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects oversized declared bodies before reading', async () => {
    const f = stream([], { 'content-length': String(32 * 1024 * 1024 + 1) });
    await expect(downloadSdn(source)).rejects.toThrow('Source unavailable');
    expect(f.read).not.toHaveBeenCalled();
  });
  it('cancels oversized streamed bodies and malformed UTF-8', async () => {
    const f = stream([new Uint8Array(32 * 1024 * 1024), new Uint8Array(1)]);
    await expect(downloadSdn(source)).rejects.toThrow('Source too large'); expect(f.cancel).toHaveBeenCalledOnce();
    const invalid = stream([new Uint8Array([0xff])]);
    await expect(downloadSdn(source)).rejects.toThrow(); expect(invalid.cancel).toHaveBeenCalledOnce();
  });
  it('refuses error statuses, missing bodies and untrusted sources', async () => {
    const fetch = vi.fn(async () => ({ status: 503, headers: new Headers(), body: null }));
    vi.stubGlobal('fetch', fetch);
    await expect(downloadSdn(source)).rejects.toThrow('Source unavailable');
    fetch.mockResolvedValue({ status: 200, headers: new Headers(), body: null });
    await expect(downloadSdn(source)).rejects.toThrow('Source unavailable');
    fetch.mockClear();
    for (const url of ['https://treasury.gov.evil.test/list', source + '#fragment', 'http://treasury.gov/list'])
      await expect(downloadSdn(url)).rejects.toThrow('Invalid source');
    expect(fetch).not.toHaveBeenCalled();
  });
});
