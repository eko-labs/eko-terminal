import { useEffect } from 'react';
import { publicSharePath, ShareMetaSchema, type ShareMeta } from '@eko/shared';
import { fetchParsed } from './api';

/** Text/attribute APIs only; the host uses the same server-projected metadata. */
// The page's own description and preview tags (index.html), kept so a page without share metadata still has them.
const STATIC = 'meta[name="description"]:not([data-eko-share]), meta[property^="og:"]:not([data-eko-share]), meta[name^="twitter:"]:not([data-eko-share])';
let staticTags: Element[] | null = null;
export function applyShareMeta(meta: ShareMeta | null, fallbackTitle: string) {
  staticTags ??= [...document.head.querySelectorAll(STATIC)];
  document.head.querySelectorAll('[data-eko-share], link[rel="canonical"]').forEach(tag => tag.remove());
  document.title = meta?.title ?? fallbackTitle;
  // Without share metadata the page keeps its own description (search engines and previews read it); with it, the
  // share tags replace them.
  for (const tag of staticTags) { if (meta) tag.remove(); else if (!tag.isConnected) document.head.append(tag); }
  if (!meta) return;
  const canonical = document.createElement('link'); canonical.rel = 'canonical'; canonical.href = meta.url;
  canonical.dataset.ekoShare = 'true'; document.head.append(canonical);
  const tags = { description: meta.description, 'og:type': 'website', 'og:site_name': 'EKO', 'og:title': meta.title,
    'og:description': meta.description, 'og:url': meta.url, 'twitter:card': meta.image ? 'summary_large_image' : 'summary',
    'twitter:title': meta.title, 'twitter:description': meta.description, ...(meta.image ? {
      'og:image': meta.image, 'og:image:width': '1200', 'og:image:height': '630', 'twitter:image': meta.image,
    } : {}) };
  for (const [key, value] of Object.entries(tags)) {
    const tag = document.createElement('meta'); tag.setAttribute(key.startsWith('og:') ? 'property' : 'name', key);
    tag.content = value; tag.dataset.ekoShare = 'true'; document.head.append(tag);
  }
}
export function useShareMeta(path: string, pageTitle: string) {
  useEffect(() => {
    const controller = new AbortController();
    applyShareMeta(null, `${pageTitle} · EKO`);
    if (publicSharePath(path)) void fetchParsed(`/share-meta?path=${encodeURIComponent(path)}`, ShareMetaSchema, { signal: controller.signal })
      .then(meta => { if (!controller.signal.aborted) applyShareMeta(meta, `${pageTitle} · EKO`); }).catch(() => undefined);
    return () => controller.abort();
  }, [path, pageTitle]);
}
