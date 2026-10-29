import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyShareMeta } from './share';

afterEach(() => vi.unstubAllGlobals());
describe('share metadata navigation', () => {
  it('clears stale host tags on private navigation and replaces public tags without duplicates', () => {
    type Tag = { name: string; value?: string; dataset: Record<string, string>; content?: string; rel?: string; href?: string; remove(): void; setAttribute(name: string, value: string): void };
    const tags: Tag[] = [];
    const document = { title: '', createElement(name: string): Tag {
      const tag: Tag = { name, dataset: {}, remove() { tags.splice(tags.indexOf(tag), 1); }, setAttribute(_name, value) { this.value = value; } };
      return tag;
    }, head: { querySelectorAll: () => [...tags], append: (tag: Tag) => tags.push(tag) } };
    vi.stubGlobal('document', document);
    const meta = { title: 'EKO · Buyer risk snapshot', description: 'Pending · Not financial advice', url: 'https://app.eko.example/receipt/sample-receipt' };
    applyShareMeta(meta, 'EKO');
    const count = tags.length; applyShareMeta(meta, 'EKO'); expect(tags).toHaveLength(count);
    expect(document.title).toBe(meta.title); expect(tags.find(tag => tag.rel === 'canonical')?.href).toBe(meta.url);
    expect(tags.find(tag => tag.value === 'og:description')?.content).toBe(meta.description);
    applyShareMeta(null, 'Mission Control · EKO'); expect(tags).toEqual([]); expect(document.title).toBe('Mission Control · EKO');
  });
});
