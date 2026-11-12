/* SignalOS launch video: "Bots call it. You make the call."
 * Chaos (market noise, halftone) → order (the SignalOS chart, the crew in color).
 * Screens are real captures of the app in paper mode on simulated data (see ../README.md).
 * Full option list: chaos-to-order-video skill, references/config-reference.md.
 */
const CREW = ['tideline', 'kinetic', 'recoil', 'breakline', 'meridian', 'vector', 'lumen', 'halcyon', 'deep-current', 'quorum', 'council'];
const crewProps = Object.fromEntries(CREW.map((id) => [id, { src: `assets/props/bot-${id}.png`, halftone: false, key: false }]));

window.VIDEO = {
  size: [1920, 1080],
  fps: 30,

  brand: {
    name: 'SignalOS',
    color: '#7B5CFF',
    paper: '#FFF4E0',
    ink: '#0D0C12',
    onColor: '#FFFFFF',
    font: "'Geist', 'Helvetica Neue', Arial, sans-serif",
    displayFont: "'Bricolage', 'Geist', sans-serif",
    fontUrl: 'assets/fonts/fonts.css',
    displayWeight: 800,
    titleWeight: 800,
    textWeight: 600,
    logo: 'assets/logo/pin-paper.png',
  },

  nav: ['Trade', 'Bots', 'Quant Lab', 'Portfolio'],
  navDropdowns: [],

  look: { halftone: 0.38, contrast: 1.35, brightness: 0.02, grain: 0.05 },

  props: { ...crewProps },

  screens: {
    dashboard: 'assets/screens/dashboard.png',
    trade: 'assets/screens/trade.png',
    bots: 'assets/screens/bots.png',
    lab: 'assets/screens/lab.png',
  },

  acts: [
    { type: 'chaos', label: 'Charts have always been noise', duration: 3.4,
      headline: 'Charts have always been', glitchWord: 'noise', fontSize: 0.064,
      props: ['crowd', 'bell', 'fist', 'pile', 'watch', 'cash', 'ribbon', 'palm'] },

    { type: 'triptych', label: 'The problem', duration: 6.6,
      columns: [
        { label: 'Signals everywhere', visual: 'scatter', props: ['map', 'door', 'column', 'quill', 'scrap'] },
        { label: 'One price, many guesses', visual: 'split', prop: 'coin' },
        { label: 'And everyone wants your keys.', visual: 'hands', props: ['hand'], center: 'token', count: 6 },
      ], labelSize: 0.04 },

    { type: 'dissolve', label: 'ASCII dissolve', duration: 1.2, overlap: 1.2 },

    { type: 'order', label: '{brand} brings order', duration: 4.2, overlap: 0.45,
      title: '{brand}', subtitle: 'puts every call on the chart.', titleSize: 0.1, subtitleSize: 0.048,
      row: ['tideline', 'kinetic', 'recoil', 'breakline', 'meridian', 'lumen', 'quorum', 'council'],
      chart: true, monitor: true, phone: true, screen: 'dashboard' },

    { type: 'navpill', label: 'Nav tour', duration: 4.6, overlap: 0.15, fadeIn: 0.15,
      screen: 'dashboard', items: ['Trade', 'Bots', 'Quant Lab', 'Portfolio'],
      clicks: ['Bots', 'Quant Lab', 'Portfolio', 'Trade'] },

    // The signal lands on the candle; click the pill.
    { type: 'screen', label: 'Signal on the chart', duration: 2.6, screen: 'dashboard',
      from: { rx: 6, ry: -4, rz: 1, s: 0.96 },
      to: { rx: 14, ry: -10, rz: 3, s: 1.6, x: -0.34, y: 0.1 },
      cursor: [{ t: 0.0, x: 0.62, y: 0.62 }, { t: 1.6, x: 0.868, y: 0.33 }, { t: 2.2, x: 0.868, y: 0.33, click: true }] },

    // The trade card: direction band, four prices, slippage.
    { type: 'screen', label: 'Trade card', duration: 2.8, screen: 'trade',
      from: { rx: 14, ry: -10, rz: 3, s: 1.5, x: 0.02, y: 0.12 },
      to: { rx: 10, ry: -6, rz: 2, s: 1.85, x: 0.02, y: 0.18 },
      cursor: [{ t: 0.1, x: 0.62, y: 0.3 }, { t: 1.1, x: 0.6, y: 0.33 }, { t: 1.9, x: 0.582, y: 0.598 }, { t: 2.3, x: 0.582, y: 0.598, click: true }] },

    // The crew.
    { type: 'screen', label: 'Bot shop', duration: 2.3, screen: 'bots',
      from: { rx: 20, ry: -14, rz: 4, s: 1.05, x: 0.04, y: 0.06 },
      to: { rx: 12, ry: -8, rz: 2, s: 1.3, x: 0.02, y: -0.04 },
      cursor: [{ t: 0.1, x: 0.5, y: 0.5 }, { t: 1.0, x: 0.45, y: 0.47 }, { t: 1.8, x: 0.3, y: 0.658, click: true }] },

    // Don't trust a bot. Test it.
    { type: 'screen', label: 'Quant Lab', duration: 2.2, screen: 'lab',
      from: { s: 1.18, y: 0.08 }, to: { rx: 10, ry: -8, rz: 1, s: 0.94 },
      cursor: [{ t: 0.0, x: 0.3, y: 0.6 }, { t: 1.2, x: 0.228, y: 0.746 }, { t: 1.6, x: 0.228, y: 0.746, click: true }] },

    { type: 'chaos', label: 'Bots call it. You make the call.', duration: 2.9, theme: 'brand',
      headline: 'Bots call it. You make the', glitchWord: 'call.', fontSize: 0.06, textY: 0.27, textStart: 0.1, wordGap: 0.22,
      props: [{ name: 'crowd', slot: 0 }, { name: 'watch', slot: 4 }, { name: 'pile', slot: 3 }, { name: 'fist', slot: 2 }, { name: 'cash', slot: 9 }, { name: 'ribbon', slot: 6 }],
      resolve: { at: 1.7, row: ['tideline', 'kinetic', 'recoil', 'breakline', 'meridian', 'quorum', 'council'] } },

    { type: 'cta', label: 'End card', duration: 3.8,
      parts: ['Start in paper', 'on', '{brand}'], props: ['kinetic', 'meridian', 'lumen'], fontSize: 0.07 },
  ],
};
