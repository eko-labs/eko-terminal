import type { SVGProps } from 'react';

export type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
});

export const IconChart = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M2 13.5h12" />
    <path d="M4 10.5V6.5M4 5V3.5M8 11V8.5M8 7V4M12 9.5V5.5M12 4V2.5" />
    <rect x="3" y="5" width="2" height="4" rx=".5" fill="currentColor" stroke="none" />
    <rect x="7" y="6.5" width="2" height="3" rx=".5" />
    <rect x="11" y="4" width="2" height="4" rx=".5" fill="currentColor" stroke="none" />
  </svg>
);
export const IconClose = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);
export const IconReplay = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M3 8a5 5 0 1 0 1.5-3.6" />
    <path d="M3 2.5V5h2.5" />
    <path d="m7 6 3 2-3 2V6Z" fill="currentColor" />
  </svg>
);
export const IconSpark = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 1.8 9.3 6.7 14.2 8 9.3 9.3 8 14.2 6.7 9.3 1.8 8l4.9-1.3L8 1.8Z" />
  </svg>
);
export const IconExternal = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M9 3h4v4M13 3 7.5 8.5" />
    <path d="M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5" />
  </svg>
);
export const IconLock = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);

export const IconUser = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="5.5" r="2.8" />
    <path d="M3 13.8c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" />
  </svg>
);
export const IconSun = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
  </svg>
);
export const IconMoon = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M13.2 10.2A5.6 5.6 0 0 1 5.8 2.8a5.6 5.6 0 1 0 7.4 7.4Z" />
  </svg>
);
export const IconFx = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M9 2.5c-1.6-.4-2.7.3-3 2l-1.5 8.4c-.3 1.7-1.4 2.3-2.8 1.8" />
    <path d="M3.8 6.5h4.4M9.5 8.5l4 5M13.5 8.5l-4 5" />
  </svg>
);
export const IconAsk = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M6.5 1.8 7.6 5l3.2 1.1-3.2 1.1-1.1 3.2-1.1-3.2L2.2 6.1 5.4 5l1.1-3.2Z" />
    <path d="M12 9.2l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6.6-1.7Z" />
  </svg>
);

// Prototype Desk line icons (16 px grid, 1.5 stroke).
const I = ({d, children, size, ...p}: P & {d?: string}) => <svg {...base(size)} {...p}>{d ? <path d={d}/> : children}</svg>;
export const IconMark=({size = 16, ...p}: P)=><svg {...base(size)} viewBox="0 0 36 36" strokeWidth={1.25} {...p}><path d="M26 3a16 16 0 1 0 0 30M23 10a9 9 0 1 0 0 16M20 16a2.5 2.5 0 1 0 0 4"/></svg>;
export const IconSearch=(p: P)=><I {...p}><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></I>;
export const IconBell=(p: P)=><I {...p} d="M4 11V7a4 4 0 0 1 8 0v4l1.2 1.5H2.8L4 11zM6.5 14h3"/>;
export const IconWallet=(p: P)=><I {...p}><rect x="1.8" y="3.8" width="12.4" height="9" rx="1"/><path d="M1.8 6.5h12.4M11 9.5h.8"/></I>;
export const IconCheck=(p: P)=><I {...p} d="M3 8.5l3 3 7-7.5"/>;
export const IconAlert=(p: P)=><I {...p}><path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3.2M8 11.6v.4"/></I>;
export const IconOct=(p: P)=><I {...p}><path d="M5.4 1.8h5.2l3.6 3.6v5.2l-3.6 3.6H5.4l-3.6-3.6V5.4z"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></I>;
export const IconInfo=(p: P)=><I {...p}><circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.9v.4"/></I>;
export const IconShield=(p: P)=><I {...p} d="M8 1.8l5.2 2v4c0 3.2-2.3 5.3-5.2 6.4-2.9-1.1-5.2-3.2-5.2-6.4v-4z"/>;
export const IconX=(p: P)=><I {...p} d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>;
export const IconPlus=(p: P)=><I {...p} d="M8 3v10M3 8h10"/>;
export const IconArrow=(p: P)=><I {...p} d="M3 8h10M9 4l4 4-4 4"/>;
export const IconOut=(p: P)=><I {...p} d="M5 11L11 5M6.5 5H11v4.5"/>;
export const IconCopy=(p: P)=><I {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-3h-8v8h3"/></I>;
export const IconEye=(p: P)=><I {...p}><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></I>;
export const IconRadar=(p: P)=><I {...p}><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><path d="M8 8l4.2-4.2"/></I>;
export const IconPairs=(p: P)=><I {...p}><rect x="1.8" y="2.5" width="3.6" height="11" rx=".6"/><rect x="6.2" y="2.5" width="3.6" height="11" rx=".6"/><rect x="10.6" y="2.5" width="3.6" height="11" rx=".6"/></I>;
export const IconFeed=(p: P)=><I {...p} d="M2 4h12M2 8h12M2 12h8"/>;
export const IconBag=(p: P)=><I {...p}><path d="M3 5.5h10l-.8 8H3.8z"/><path d="M5.8 5.5V4a2.2 2.2 0 0 1 4.4 0v1.5"/></I>;
export const IconAgent=(p: P)=><I {...p}><rect x="3" y="5" width="10" height="8" rx="1.5"/><path d="M8 5V2.5M6 9h.1M10 9h.1"/></I>;
export const IconCrew=(p: P)=><I {...p}><circle cx="5" cy="6" r="2"/><circle cx="11" cy="6" r="2"/><path d="M7 6h2M2 13c.5-2 1.6-3 3-3s2.5 1 3 3M8 13c.5-2 1.6-3 3-3s2.5 1 3 3"/></I>;
export const IconPerson=(p: P)=><I {...p}><circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13.5c.6-2.6 2.3-4 4.5-4s3.9 1.4 4.5 4"/></I>;
export const IconFlame=(p: P)=><I {...p} d="M8 14c-2.8 0-4.5-1.9-4.5-4.3 0-2.6 2.2-3.6 2.4-6.2 1.5.9 2.3 2.2 2.4 3.6.6-.6.9-1.4.9-2.3 1.6 1.2 3.3 2.9 3.3 5 0 2.4-1.7 4.2-4.5 4.2z"/>;
export const IconPause=(p: P)=><I {...p} d="M5.5 3.5v9M10.5 3.5v9"/>;
export const IconPlay=(p: P)=><I {...p} d="M5 3.2l8 4.8-8 4.8z"/>;
export const IconStop=(p: P)=><I {...p}><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></I>;
export const IconKey=(p: P)=><I {...p}><circle cx="5" cy="10.5" r="2.8"/><path d="M7 8.5L13 2.5M11 4.5l1.6 1.6M9.4 6.1l1.2 1.2"/></I>;
export const IconBolt=(p: P)=><I {...p} d="M9 1.8L3.5 9h4l-1 5.2L12.5 7h-4z"/>;
export const IconLab=(p: P)=><I {...p} d="M6 2h4M6.8 2v4.2L2.8 13c-.3.6.1 1.2.8 1.2h8.8c.7 0 1.1-.6.8-1.2L9.2 6.2V2M4.6 10h6.8"/>;
export const IconLink=(p: P)=><I {...p} d="M6.5 9.5l3-3M5 8L3.5 9.5a2.1 2.1 0 0 0 3 3L8 11M8 5l1.5-1.5a2.1 2.1 0 0 1 3 3L11 8"/>;
export const IconMenu=(p: P)=><I {...p} d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>;
export const IconExpand=(p: P)=><I {...p} d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9"/>;
export const IconHome=(p: P)=><I {...p} d="M2.5 7.5L8 3l5.5 4.5V13h-11z"/>;
export const IconScore=(p: P)=><I {...p} d="M3 13V8M8 13V3M13 13V6"/>;
export const IconPlug=(p: P)=><I {...p} d="M6 2v4M10 2v4M4 6h8v2a4 4 0 0 1-8 0zM8 12v2"/>;
export const IconChevron=(p: P)=><I {...p} d="M6 3.5L10.5 8 6 12.5"/>;

export const IconOctagonX = IconOct;
export const IconTriangle = IconAlert;
export const IconChainLink = IconLink;
export const IconFlask = IconLab;
export const IconEcho = IconMark;
export const IconRobotOutline = IconAgent;
export const IconRobot = (p: P) => <I {...p}><rect x="3" y="5" width="10" height="8" rx="1.5" fill="currentColor"/><path d="M8 5V2.5"/><path d="M6 9h.1M10 9h.1" stroke="var(--bg)"/></I>;
export const IconShieldCheck = (p: P) => <I {...p}><path d="M8 1.8l5.2 2v4c0 3.2-2.3 5.3-5.2 6.4-2.9-1.1-5.2-3.2-5.2-6.4v-4z"/><path d="m5 8 2 2 4-4"/></I>;
export const IconScan = (p: P) => <I {...p} d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4M4 8h8"/>;
export const IconPower = (p: P) => <I {...p}><path d="M8 1v6M4 3.5a6 6 0 1 0 8 0"/></I>;
export const IconApproval = (p: P) => <I {...p}><rect x="3" y="2" width="10" height="12" rx="1"/><path d="m5 8 2 2 4-4"/></I>;
export const IconJournal = (p: P) => <I {...p}><rect x="3" y="2" width="10" height="12" rx="1"/><path d="M6 5h4M6 8h4M6 11h2"/></I>;
export const IconReceipt = IconJournal;
export const IconResearch = IconSearch;
export const IconPolicy = IconShield;
export const IconShare = (p: P) => <I {...p}><path d="M8 10V1m-3 3 3-3 3 3M3 7v7h10V7"/></I>;
export const IconQr = (p: P) => <I {...p}><path d="M2 2h4v4H2zM10 2h4v4h-4zM2 10h4v4H2zM10 10h2v2h2v2h-4z"/></I>;
