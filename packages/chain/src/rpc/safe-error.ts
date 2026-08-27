/** An error's reason without secrets: RPC URLs (which carry provider keys) and request bodies are removed. */
export function safeError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  for (let depth=0;current!=null && depth<8 && !seen.has(current);depth++) {
    seen.add(current);
    const e = current as { shortMessage?: unknown; message?: unknown; details?: unknown; cause?: unknown };
    for (const part of [e.shortMessage ?? e.message ?? (typeof current === 'string' ? current : undefined),e.details]) {
      if (typeof part !== 'string') continue;
      // Sanitize each cause independently: a wrapper's body must not swallow
      // the provider's useful reason in a subsequent details/cause field.
      const reason = part
        .replace(/(?:Request body|Request parameters|Request headers|Headers|Raw Call Arguments|Contract Call|Call Arguments):[\s\S]*/i, '')
        .replace(/\b(?:URL|Version):[^\n]*/gi, '')
        .replace(/(?:https?|wss?):\/\/\S+/gi, '<url>')
        .replace(/(?:[?&]|\b)(?:dkey|key|api[-_]?key|token|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^&\s,;]+)/gi, '<redacted>')
        .replace(/\{[\s\S]*|\[[\s\S]*/, '')
        .replace(/\s+/g, ' ').trim();
      if (reason && !parts.includes(reason)) parts.push(reason);
    }
    current = e.cause;
  }
  return (parts.join(' | ') || 'unknown error').slice(0,300);
}
