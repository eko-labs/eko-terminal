/** Strict reader for the legacy SDN XML export; no DTDs, external entities or recovery. */
interface Node { name: string; text: string; children: Node[] }
const invalid = () => new Error('Invalid sanctions export');
function decode(text: string): string {
  return text.replace(/&([^;]+);/g, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[entity]) return named[entity];
    const code = /^#\d+$/.test(entity) ? Number(entity.slice(1)) : /^#x[\da-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : NaN;
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw invalid();
    return String.fromCodePoint(code);
  });
}
function xml(text: string): Node {
  if (text.includes('<!DOCTYPE') || text.includes('<!ENTITY')) throw invalid();
  const root: Node = { name: '', text: '', children: [] }, stack = [root];
  const tokens = /<!--[\s\S]*?-->|<\?xml\s[^?]*\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g;
  let end = 0;
  for (const match of text.matchAll(tokens)) {
    if (match.index !== end) throw invalid();
    const part = match[0]; end += part.length;
    const current = stack.at(-1)!;
    if (part.startsWith('<!--') || part.startsWith('<?xml')) continue;
    if (part.startsWith('<![CDATA[')) { current.text += part.slice(9, -3); continue; }
    if (part.startsWith('</')) {
      if (stack.length === 1 || part !== `</${current.name}>`) throw invalid();
      stack.pop();
    } else if (part.startsWith('<')) {
      const tag = /^<([A-Za-z_][\w:.-]*)(?:\s+[\w:.-]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*(\/?)>$/.exec(part);
      if (!tag || stack.length > 64) throw invalid();
      const node: Node = { name: tag[1]!, text: '', children: [] };
      current.children.push(node);
      if (!tag[2]) stack.push(node);
    } else {
      if (/&(?![^\s&;]+;)/.test(part)) throw invalid();
      current.text += decode(part);
    }
  }
  if (end !== text.length || stack.length !== 1 || root.children.length !== 1 || root.text.trim()) throw invalid();
  return root.children[0]!;
}
function one(node: Node, name: string): Node {
  const children = node.children.filter(c => c.name === name);
  if (children.length !== 1) throw invalid();
  return children[0]!;
}
function value(node: Node, name: string): string {
  const child = one(node, name);
  if (child.children.length || !child.text.trim()) throw invalid();
  return child.text.trim();
}
export function normalizeWallet(wallet: string): string {
  if (!/^0x[\da-f]{40}$/i.test(wallet.trim())) throw invalid();
  return wallet.trim().toLowerCase();
}
export interface ParsedSdn { publishedAt: string; recordCount: number; addresses: string[] }
export function parseSdn(text: string): ParsedSdn {
  const root = xml(text);
  if (root.name !== 'sdnList') throw invalid();
  const publication = one(root, 'publshInformation'); // Spelling used by legacy SDN XML.
  const publishedAt = value(publication, 'Publish_Date');
  const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(publishedAt);
  if (!date) throw invalid();
  const iso = `${date[3]}-${date[1]}-${date[2]}T00:00:00.000Z`;
  if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString() !== iso) throw invalid();
  const count = value(publication, 'Record_Count');
  if (!/^[1-9]\d*$/.test(count)) throw invalid();
  const recordCount = Number(count), entries = root.children.filter(c => c.name === 'sdnEntry');
  if (entries.length !== recordCount) throw invalid();
  const ids = new Set<string>(), addresses = new Set<string>();
  for (const entry of entries) {
    const uid = value(entry, 'uid');
    if (ids.has(uid)) throw invalid();
    ids.add(uid);
    for (const list of entry.children.filter(c => c.name === 'idList')) {
      for (const id of list.children) {
        if (id.name !== 'id') throw invalid();
        const type = value(id, 'idType');
        if (!type.startsWith('Digital Currency Address')) continue;
        if (!/^Digital Currency Address - [A-Z0-9]+$/.test(type)) throw invalid();
        const address = value(id, 'idNumber');
        // All EVM-shaped digital-currency addresses are screened regardless of currency label.
        if (/^0x/i.test(address)) addresses.add(normalizeWallet(address));
        else if (type === 'Digital Currency Address - ETH') throw invalid();
        else addresses.add(address);
      }
    }
  }
  // A format change or unexpectedly empty address set must not erase a usable list.
  if (!addresses.size) throw invalid();
  return { publishedAt: iso, recordCount, addresses: [...addresses].sort() };
}
