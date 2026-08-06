import { describe, expect, it } from 'vitest';
import { publicShareOrigin, publicSharePath, shareHead, shareMetadata } from '../src/index.js';
describe('public URL allowlists and escaped crawler tags', () => {
  it('accepts only exact public share paths and canonicalizes addresses', () => {
    for (const path of ['/bags', '/wallets/0x01/bags', '/mission/agents/sample-agent', '/scan/unknown', '/receipt/%22', '//hostile.example', '/receipt/a?secret=fixture', '/coin/' + 'a'.repeat(40)]) expect(publicSharePath(path)).toBeNull();
    expect(publicSharePath('/coin/0x' + 'A'.repeat(40))?.path).toBe('/coin/0x' + 'a'.repeat(40));
    expect(publicSharePath('/receipt/sample-receipt')?.kind).toBe('receipt');
    const receipt = publicSharePath('/receipt/verdict:sample-revision');
    expect(receipt).toEqual({ kind: 'receipt', id: 'verdict:sample-revision', path: '/receipt/verdict%3Asample-revision' });
    expect(publicSharePath('/receipt/verdict%3Asample-revision')).toEqual(receipt);
    for (const path of ['/receipt/verdict%2Fsample', '/receipt/verdict%5Csample', '/receipt/%2e%2e', '/receipt/verdict%253Asample', '/receipt/%ZZ']) expect(publicSharePath(path)).toBeNull();
  });
  it('rejects credentials, path components and nonpublic HTTP origins', () => {
    for (const origin of ['https://app.eko.example/path', 'https://app.eko.example/', 'http://hostile.example', 'https://sample-user:fixture@app.eko.example', 'javascript:fixture']) expect(() => publicShareOrigin(origin)).toThrow();
    expect(publicShareOrigin('https://app.eko.example')).toBe('https://app.eko.example');
    expect(publicShareOrigin('http://localhost:5180')).toBe('http://localhost:5180');
  });
  it('escapes attribute and title delimiters and produces scan large-image unfurl tags', () => {
    const path = publicSharePath('/scan/scan-' + 'a'.repeat(64))!;
    const meta = shareMetadata('https://app.eko.example', path, 'EKO "<fixture>&\'', 'Pending', true);
    const html = shareHead(meta);
    expect(html).not.toContain('<fixture>'); expect(html).toContain('&quot;&lt;fixture&gt;&amp;&#39;');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('/og/scan/scan-' + 'a'.repeat(64) + '.png');
    expect(html).toContain('property="og:image:width" content="1200"'); expect(html).toContain('rel="canonical"');
  });
});
