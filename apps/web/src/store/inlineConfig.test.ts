import { afterEach, describe, expect, it } from 'vitest';
import { inlineConfig } from './shell';
import { createConfig } from '../mocks/responses';

// The web tests run without a DOM: a minimal document holding the server's <script id="eko-config">.
const withPage = (text: string | null) => {
  (globalThis as { document?: unknown }).document = { getElementById: (id: string) => (id === 'eko-config' && text !== null ? { textContent: text } : null) };
};

describe('config inlined in the page by the server', () => {
  afterEach(() => { delete (globalThis as { document?: unknown }).document; });
  it('is read before the first render', () => {
    withPage(JSON.stringify(createConfig()));
    expect(inlineConfig()?.flags).toEqual(createConfig().flags);
  });
  it('is ignored when missing, unparseable or not a config', () => {
    expect(inlineConfig()).toBeNull();
    withPage(null); expect(inlineConfig()).toBeNull();
    withPage('{"phase":'); expect(inlineConfig()).toBeNull();
    withPage('{"phase":"nope"}'); expect(inlineConfig()).toBeNull();
  });
});
