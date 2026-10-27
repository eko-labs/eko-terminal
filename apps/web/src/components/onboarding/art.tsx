import { useId, type CSSProperties, type ReactNode } from 'react';

/**
 * Onboarding illustrations. Everything is inline SVG/CSS in the brand's glossy "jelly" material
 * (the same lit-tube treatment as the logo mark and bot avatars) — no external images.
 */

const BLOBS = {
  // Soft organic lobes; all drawn in a 200×200 box.
  a: 'M104 18c30 0 62 14 74 44 12 29-2 52-8 76-6 25-24 46-54 50-30 5-60-6-79-29C18 136 10 108 18 80 26 51 52 18 104 18Z',
  b: 'M96 14c36-4 70 14 86 46 14 30 2 58-12 84-15 27-44 44-76 40-31-3-60-26-70-56C14 98 26 64 48 40 60 26 76 16 96 14Z',
  c: 'M110 20c34 6 62 32 70 64 8 33-10 64-38 82-27 17-64 20-92 2C24 150 10 116 18 84c9-34 42-72 92-64Z',
} as const;

/** A glossy blob in brand blues: base gradient, contact shadow, rim and a masked specular highlight. */
export function GlossBlob({ variant = 'a', size = 220, className = '', style, hue }: { variant?: keyof typeof BLOBS; size?: number; className?: string; style?: CSSProperties; hue?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const d = BLOBS[variant];
  const h = hue ?? 212;
  return (
    <svg className={`ob-blob ${className}`} width={size} height={size} viewBox="0 0 200 200" style={style} aria-hidden>
      <defs>
        <linearGradient id={`${id}g`} x1="40" y1="10" x2="160" y2="200" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={`hsl(${h - 12} 100% 82%)`} />
          <stop offset=".32" stopColor={`hsl(${h} 100% 62%)`} />
          <stop offset=".72" stopColor={`hsl(${h + 8} 84% 45%)`} />
          <stop offset="1" stopColor={`hsl(${h + 14} 88% 24%)`} />
        </linearGradient>
        <radialGradient id={`${id}r`} cx="30%" cy="22%" r="60%">
          <stop offset="0" stopColor="#fff" stopOpacity=".75" />
          <stop offset=".45" stopColor="#fff" stopOpacity=".08" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}s`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <filter id={`${id}b`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
        <clipPath id={`${id}c`}>
          <path d={d} />
        </clipPath>
      </defs>
      <path d={d} fill={`hsl(${h + 14} 90% 12%)`} opacity=".55" transform="translate(6 14)" filter={`url(#${id}s)`} />
      <path d={d} fill={`url(#${id}g)`} />
      <g clipPath={`url(#${id}c)`}>
        {/* inner shade along the lower edge, then the glossy highlight */}
        <path d={d} fill="none" stroke={`hsl(${h + 16} 90% 18%)`} strokeOpacity=".55" strokeWidth="22" transform="translate(-4 -12)" filter={`url(#${id}b)`} />
        <path d={d} fill={`url(#${id}r)`} />
        <ellipse cx="72" cy="52" rx="34" ry="14" fill="#fff" opacity=".55" transform="rotate(-24 72 52)" filter={`url(#${id}b)`} />
      </g>
      <path d={d} fill="none" stroke="#fff" strokeOpacity=".22" strokeWidth="1.2" />
    </svg>
  );
}

const TUBES = {
  wave: 'M22 132C22 70 70 48 98 92s74 58 80-18',
  loop: 'M40 100c0-34 26-54 52-38s38 76 70 76 34-40 10-62-58 8-78 30-54 28-54-6Z',
} as const;

/** The brand's glossy "jelly tube" (the logo's material): a thick lit stroke with depth, rim and highlight. */
export function GlossTube({ variant = 'wave', size = 240, width = 34, className = '', style }: { variant?: keyof typeof TUBES; size?: number; width?: number; className?: string; style?: CSSProperties }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const d = TUBES[variant];
  return (
    <svg className={`ob-blob ${className}`} width={size} height={size} viewBox="0 0 200 200" style={style} aria-hidden>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="30" x2="0" y2="180" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#b4e6ff" />
          <stop offset=".3" stopColor="#3aa0ff" />
          <stop offset=".72" stopColor="#1459e6" />
          <stop offset="1" stopColor="#0a2e91" />
        </linearGradient>
        <mask id={`${id}m`}>
          <path d={d} stroke="#fff" strokeWidth={width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </mask>
        <filter id={`${id}s`} x="-20%" y="-20%" width="140%" height="160%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <filter id={`${id}b`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>
      <path d={d} stroke="#021338" strokeOpacity=".55" strokeWidth={width} fill="none" strokeLinecap="round" strokeLinejoin="round" transform="translate(3 12)" filter={`url(#${id}s)`} />
      <path d={d} stroke="#0a2c85" strokeWidth={width} fill="none" strokeLinecap="round" strokeLinejoin="round" transform="translate(0 4)" />
      <path d={d} stroke={`url(#${id}g)`} strokeWidth={width} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <g mask={`url(#${id}m)`}>
        <path d={d} stroke="#021a5c" strokeOpacity=".35" strokeWidth={width * 0.5} fill="none" strokeLinecap="round" transform={`translate(0 ${width * 0.42})`} filter={`url(#${id}b)`} />
        <path d={d} stroke="#fff" strokeOpacity=".62" strokeWidth={width * 0.2} fill="none" strokeLinecap="round" transform={`translate(-1 ${-width * 0.27})`} filter={`url(#${id}b)`} />
      </g>
    </svg>
  );
}

/** Welcome card 3: pick an amount → tap Buy → done. Nothing happens without the tap. */
export function TapFlow() {
  return (
    <div className="ob-tap" aria-hidden>
      <div className="ob-tap-box">
        <span className="ob-tap-step">
          <Callout n={1} />
        </span>
        <div className="ob-tap-chips num">
          {[50, 100, 250, 500].map((v) => (
            <span key={v} className={v === 100 ? 'is-on' : ''}>
              ${v}
            </span>
          ))}
        </div>
        <span className="ob-tap-step">
          <Callout n={2} />
        </span>
        <div className="ob-tap-btns">
          <span className="ob-tap-btn is-buy">
            Buy $100
            <span className="ob-tap-ripple" />
          </span>
          <span className="ob-tap-btn is-sell">Sell $100</span>
        </div>
      </div>
      <div className="ob-tap-done">
        <Callout n={3} />
        <span className="ob-tap-check">
          <svg viewBox="0 0 16 16" width="12" height="12">
            <path d="m4 8.4 2.6 2.6L12 5.4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span>
          <b>Bought 0.0376 ETH</b>
          <small className="num">at $2,656.12 · paper</small>
        </span>
      </div>
    </div>
  );
}

function Callout({ n, style }: { n: number; style?: CSSProperties }) {
  return (
    <span className="ob-callout num" style={style} aria-hidden>
      {n}
    </span>
  );
}

/** Small check/cross/pending status glyph used by the checklist and Live requirements. */
export function StatusDot({ state }: { state: 'ok' | 'todo' | 'fail' | 'wait' | 'na' }) {
  return (
    <span className={`ob-status ob-status--${state}`} aria-hidden>
      {state === 'ok' ? (
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path d="m4 8.4 2.6 2.6L12 5.4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : state === 'fail' ? (
        <svg viewBox="0 0 16 16" width="11" height="11">
          <path d="m5 5 6 6M11 5l-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      ) : state === 'wait' ? (
        <span className="spinner" />
      ) : null}
    </span>
  );
}
