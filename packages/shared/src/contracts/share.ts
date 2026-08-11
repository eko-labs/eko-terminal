import { z } from 'zod';
import { DYOR, NON_AFFILIATION } from './guard-copy.js';

export const ShareMetaSchema = z.object({ title: z.string(), description: z.string(), url: z.url(), image: z.url().optional() });
export type ShareMeta = z.infer<typeof ShareMetaSchema>;
export type SharePath = { kind: 'scan' | 'bags' | 'receipt' | 'coin'; id: string; path: string };
/** Exact path allowlist: query strings, encoded separators and arbitrary URLs cannot become canonicals. */
export function publicSharePath(path: string): SharePath | null {
  let match = /^\/scan\/(scan-[a-f0-9]{64})$/.exec(path);
  if (match) return { kind: 'scan', id: match[1], path };
  match = /^\/bags\/r\/([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i.exec(path);
  if (match) return { kind: 'bags', id: match[1].toLowerCase(), path: path.toLowerCase() };
  match = /^\/receipt\/([^/]{1,768})$/.exec(path);
  if (match) {
    try {
      const id = decodeURIComponent(match[1]);
      if (/^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,255}$/.test(id)) return { kind: 'receipt', id, path: `/receipt/${encodeURIComponent(id)}` };
    } catch { return null; }
    return null;
  }
  match = /^\/coin\/(0x[a-fA-F0-9]{40})$/.exec(path);
  return match ? { kind: 'coin', id: match[1].toLowerCase(), path: path.toLowerCase() } : null;
}
export function publicShareOrigin(origin: string) {
  const https = /^https:\/\/(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\])(?::[0-9]{1,5})?$/.test(origin);
  const local = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/.test(origin);
  if ((!https && !local) || !z.url().safeParse(origin).success) throw new Error('Invalid public share origin');
  return origin;
}
export function shareMetadata(origin: string, path: SharePath, title: string, description: string, image = false): ShareMeta {
  publicShareOrigin(origin);
  const allowed = publicSharePath(path.path);
  if (!allowed || allowed.kind !== path.kind || allowed.id !== path.id) throw new Error('Invalid public share path');
  return { title, description: `${description} · ${DYOR} · ${NON_AFFILIATION}`, url: `${origin}${path.path}`,
    ...(image && (path.kind === 'scan' || path.kind === 'bags') ? { image: `${origin}/og/${path.kind}/${path.id}.png` } : {}) };
}
const escaped = (value: string) => value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
export function shareHead(meta: ShareMeta) {
  const tags = { description: meta.description, 'og:type': 'website', 'og:site_name': 'EKO', 'og:title': meta.title,
    'og:description': meta.description, 'og:url': meta.url, 'twitter:card': meta.image ? 'summary_large_image' : 'summary',
    'twitter:title': meta.title, 'twitter:description': meta.description, ...(meta.image ? {
      'og:image': meta.image, 'og:image:width': '1200', 'og:image:height': '630', 'twitter:image': meta.image,
    } : {}) };
  return `<title>${escaped(meta.title)}</title><link rel="canonical" href="${escaped(meta.url)}">` + Object.entries(tags)
    .map(([key, value]) => `<meta ${key.startsWith('og:') ? 'property' : 'name'}="${key}" content="${escaped(value)}">`).join('');
}
