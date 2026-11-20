import { useEffect, useState, type MouseEvent } from 'react';
import { IconCopy } from '../icons';
import { useShell } from '../../store/shell';

/** Copy text: the Clipboard API, else a selected textarea and execCommand (older or locked-down browsers). */
const copyText = (text: string): Promise<void> =>
  navigator.clipboard?.writeText(text).catch(() => legacyCopy(text)) ?? legacyCopy(text);
function legacyCopy(text: string): Promise<void> {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
}
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The project's token contract address with a copy button, once the edge serves one (config `token`); nothing until then. */
export function TokenCa({ compact = false }: { compact?: boolean }) {
  const token = useShell((s) => s.config?.token);
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(null), 1600); return () => clearTimeout(t); }, [copied]);
  if (!token) return null;
  const label = token.symbol ? `$${token.symbol} CA` : 'CA';
  const copy = (e: MouseEvent) => {
    e.stopPropagation();
    void copyText(token.address).then(() => setCopied('ok'), () => setCopied('failed'));
  };
  return (
    <button type="button" className={`token-ca${compact ? ' compact' : ''}${copied === 'ok' ? ' copied' : ''}`} onClick={copy}
      title={token.address} aria-label={`Copy ${label}: ${token.address}`}>
      <span className="token-ca-label">{compact ? 'CA' : label}</span>
      {!compact && <span className="num token-ca-addr">{short(token.address)}</span>}
      <span className="token-ca-act" aria-live="polite">{copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : <IconCopy aria-hidden />}</span>
    </button>
  );
}
