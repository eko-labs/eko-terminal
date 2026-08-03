/** RFC 8785 §3: ECMAScript primitives, recursive UTF-16 key sorting, no normalization.
 * Accepts parsed JSON data only; rejects invalid Unicode, non-finite numbers and cycles.
 * Reference: https://www.rfc-editor.org/rfc/rfc8785
 */
export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>();
  function quote(text: string): string {
    if (/[\uD800-\uDFFF]/u.test(text)) throw new TypeError('JCS requires valid Unicode');
    return JSON.stringify(text);
  }
  function serialize(input: unknown): string {
    if (input === null) return 'null';
    if (typeof input === 'string') return quote(input);
    if (typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new TypeError('JCS requires finite numbers');
      return JSON.stringify(input);
    }
    if (typeof input !== 'object') throw new TypeError('JCS requires JSON data');
    if (ancestors.has(input)) throw new TypeError('JCS cannot serialize a cycle');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        return '[' + Array.from(input, serialize).join(',') + ']';
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('JCS requires plain objects');
      const object = input as Record<string, unknown>;
      return '{' + Object.keys(object).sort().map((key) => quote(key) + ':' + serialize(object[key])).join(',') + '}';
    } finally {
      ancestors.delete(input);
    }
  }
  return serialize(value);
}

