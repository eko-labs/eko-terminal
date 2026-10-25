import { useId } from 'react';
import { useApp } from '../store/app';

/** EKO echo mark from the day-one brand contract. */
export function Lockup({ height = 30, tone = 'ink' }: { height?: number; tone?: 'ink' | 'white' }) {
  return <span className="lockup" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: height, color: tone === 'white' ? '#d4f4fa' : 'currentColor' }}><LogoMark size={height} /><span>EKO</span></span>;
}

export function LogoMark({ size = 28 }: { size?: number }) {
  return <svg className="logomark" width={size} height={size} viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden><path d="M26 3a16 16 0 1 0 0 30M23 10a9 9 0 1 0 0 16M20 16a2.5 2.5 0 1 0 0 4" /></svg>;
}

const COIN: Record<string, { bg: string; fg?: string }> = {
  ETH: { bg: '#e2e6f4' },
  BTC: { bg: '#f7931a' },
  SOL: { bg: '#0b0d14' },
  DOGE: { bg: '#c7a638' },
  AVAX: { bg: '#e84142' },
  LINK: { bg: '#2a5ada' },
  UNI: { bg: '#fde6f2' },
  ARB: { bg: '#1f2f45' },
  SUI: { bg: '#4da2ff' },
  PEPE: { bg: '#3d8b37' },
};

function glyphFor(sym: string, id: string) {
  switch (sym) {
    case 'ETH':
      return (
        <>
          <path d="M16 5.5 22.6 16.4 16 20.3 9.4 16.4Z" fill="#3b3d5c" />
          <path d="M16 5.5v14.8l-6.6-3.9Z" fill="#6b6e98" />
          <path d="M16 21.7 22.6 17.8 16 26.8 9.4 17.8Z" fill="#3b3d5c" />
          <path d="M16 21.7v5.1l-6.6-9Z" fill="#6b6e98" />
        </>
      );
    case 'BTC':
      return (
        <g transform="rotate(12 16 16)" fill="#fff">
          <path d="M12 9h6.2c2.6 0 4 1.3 4 3.3 0 1.4-.8 2.4-2 2.8 1.6.3 2.6 1.5 2.6 3.2 0 2.3-1.6 3.7-4.4 3.7H12Zm3 2.5v3.3h2.7c1.1 0 1.7-.6 1.7-1.6 0-1.1-.6-1.7-1.7-1.7Zm0 5.6v3.5h3c1.2 0 1.9-.6 1.9-1.7 0-1.1-.7-1.8-1.9-1.8Z" fillRule="evenodd" />
          <rect x="14" y="7" width="1.6" height="2.4" rx=".5" />
          <rect x="17" y="7" width="1.6" height="2.4" rx=".5" />
          <rect x="14" y="21.6" width="1.6" height="2.4" rx=".5" />
          <rect x="17" y="21.6" width="1.6" height="2.4" rx=".5" />
        </g>
      );
    case 'SOL':
      return (
        <>
          <defs>
            <linearGradient id={`${id}s`} x1="8" y1="24" x2="24" y2="8" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#9945ff" />
              <stop offset="1" stopColor="#14f195" />
            </linearGradient>
          </defs>
          <g fill={`url(#${id}s)`}>
            <path d="M11 9.5h12.5l-2.5 2.8H8.5Z" />
            <path d="M8.5 14.6H21l2.5 2.8H11Z" />
            <path d="M11 19.7h12.5L21 22.5H8.5Z" />
          </g>
        </>
      );
    case 'DOGE':
      return <path d="M11 9h5.6c4.2 0 6.6 2.7 6.6 7s-2.4 7-6.6 7H11v-5.8H9.4v-2.4H11Zm3.2 2.8v3.4h3.2v2.4h-3.2v3.6h2.3c2.3 0 3.5-1.5 3.5-4.2s-1.2-4.2-3.5-4.2Z" fill="#fff" fillRule="evenodd" />;
    case 'AVAX':
      return (
        <g fill="#fff">
          <path d="M14.6 8.6c.6-1 2-1 2.6 0l1.3 2.2-4.8 8.4c-.3.5-.8.8-1.4.8H9.5c-1.2 0-1.9-1.3-1.3-2.3Z" />
          <path d="M19.6 13.4c.6-1 2-1 2.6 0l3 5.3c.6 1-.1 2.3-1.3 2.3h-6c-1.2 0-1.9-1.3-1.3-2.3Z" />
        </g>
      );
    case 'LINK':
      return <path d="M16 7.2 23.6 11.6v8.8L16 24.8l-7.6-4.4v-8.8Z" fill="none" stroke="#fff" strokeWidth="3" strokeLinejoin="round" />;
    case 'UNI':
      return <path d="M11 9v8.2c0 3.3 2.1 5.5 5 5.5s5-2.2 5-5.5V9" fill="none" stroke="#ff2e8f" strokeWidth="3.2" strokeLinecap="round" />;
    case 'ARB':
      return (
        <>
          <path d="M16 6.5 24.2 11.2v9.6L16 25.5l-8.2-4.7v-9.6Z" fill="none" stroke="#9dccf5" strokeWidth="1.4" />
          <path d="m13.8 11.5 1.9-.1-5 10.4-1.8-1Z" fill="#fff" />
          <path d="m17.4 11.4 1.9.1 3.6 7.8-1.7 1.3Z" fill="#28a0f0" />
          <path d="m15.4 13.8 1.1 2.3-2.5 5.7-1.9-1.1Z" fill="#28a0f0" />
        </>
      );
    case 'SUI':
      return <path d="M16 7c3.2 3.6 6 7.2 6 10.6A6 6 0 0 1 10 17.6C10 14.2 12.8 10.6 16 7Z" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinejoin="round" />;
    case 'PEPE':
      return (
        <>
          <circle cx="12" cy="13.5" r="3.4" fill="#fff" />
          <circle cx="20" cy="13.5" r="3.4" fill="#fff" />
          <circle cx="12.8" cy="13.8" r="1.5" fill="#101418" />
          <circle cx="20.8" cy="13.8" r="1.5" fill="#101418" />
          <path d="M10 20.5c3.6 2 8.4 2 12 0" stroke="#7a1f1f" strokeWidth="1.8" fill="none" strokeLinecap="round" />
        </>
      );
    default:
      return null;
  }
}

/** Coin glyph: a simplified, recognisable symbol on its coin colour. Unknown assets fall back to their initial. */
export function CoinGlyph({ market, size = 28 }: { market: string; size?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const accent = useApp((s) => s.config?.markets.find((m) => m.id === market)?.accent);
  const sym = market.split('-')[0] ?? market;
  const c = COIN[sym] ?? { bg: accent ?? '#2f95ff' };
  const g = glyphFor(sym, id);
  return (
    <svg className="coin" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="16" fill={c.bg} />
      {g ?? (
        <text x="16" y="21" textAnchor="middle" fontSize="14" fontWeight="800" fill="#fff" fontFamily="var(--font-ui)">
          {sym.slice(0, 1)}
        </text>
      )}
      <circle cx="16" cy="16" r="15.5" fill="none" stroke="rgba(255,255,255,.08)" />
    </svg>
  );
}
