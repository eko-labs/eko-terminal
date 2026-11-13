/* Procedural stand-ins so a video renders before real assets exist.
 *
 * Props are drawn in grayscale and then pass through the same halftone treatment
 * as real photo cutouts. Screens are simple dark trading-app mockups in color.
 * Replace them with real images via VIDEO.props / VIDEO.screens.
 */
(function () {
  const V = E.V;
  const mk = (w, h) => { const c = E.mkCanvas(w, h); return [c, c.getContext('2d')]; };
  const lin = (ctx, x0, y0, x1, y1, stops) => { const g = ctx.createLinearGradient(x0, y0, x1, y1); stops.forEach((s, i) => g.addColorStop(Array.isArray(s) ? s[0] : i / (stops.length - 1), Array.isArray(s) ? s[1] : s)); return g; };
  const rad = (ctx, x, y, r0, r1, stops) => { const g = ctx.createRadialGradient(x, y, r0, x, y, r1); stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s)); return g; };
  const rr = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
  const SKIN = ['#efefef', '#cfcfcf', '#a3a3a3'];
  const skin = (ctx, x0, x1) => lin(ctx, x0, 0, x1, 0, SKIN);
  const OUT = '#2b2b2b';

  function capsule(ctx, x, y, len, w, angDeg, fill) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(angDeg * Math.PI / 180);
    rr(ctx, -w / 2, -len, w, len + w / 2, w / 2);
    ctx.fillStyle = fill || skin(ctx, -w / 2, w / 2); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = OUT; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-w * 0.3, -len * 0.45); ctx.lineTo(w * 0.25, -len * 0.47); ctx.lineWidth = 2; ctx.strokeStyle = '#6b6b6b'; ctx.stroke();
    ctx.restore();
  }
  function sleeve(ctx, x0, y0, w, len, shade) {
    ctx.fillStyle = lin(ctx, x0, 0, x0 + w, 0, [shade || '#7a7a7a', '#4a4a4a', '#8a8a8a', '#3a3a3a']);
    ctx.fillRect(x0, y0, w, len);
    ctx.fillStyle = lin(ctx, x0, 0, x0 + w, 0, ['#ffffff', '#d9d9d9']);
    ctx.fillRect(x0 + 6, y0 - 18, w - 12, 30);
  }
  // Open hand, fingers up, wrist at (0,0).
  function openHand(ctx, opts = {}) {
    if (opts.sleeve !== false) sleeve(ctx, -64, 12, 128, opts.sleeveLen || 420, opts.shade);
    capsule(ctx, -50, -60, 92, 36, -48);
    rr(ctx, -60, -175, 120, 185, 42); ctx.fillStyle = skin(ctx, -60, 60); ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = OUT; ctx.stroke();
    [[-43, 104, 30, -9], [-14, 122, 31, -2], [15, 112, 30, 5], [42, 86, 26, 12]].forEach(([x, l, w, a]) => capsule(ctx, x, -160, l, w, a));
    ctx.beginPath(); ctx.moveTo(-40, -95); ctx.quadraticCurveTo(0, -70, 42, -110); ctx.strokeStyle = '#7a7a7a'; ctx.lineWidth = 2; ctx.stroke();
  }
  // Fist seen from the front, knuckles up, wrist at (0,0).
  function fist(ctx, opts = {}) {
    if (opts.sleeve !== false) sleeve(ctx, -66, 0, 132, opts.sleeveLen || 520, opts.shade);
    rr(ctx, -66, -160, 132, 170, 38); ctx.fillStyle = skin(ctx, -66, 66); ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = OUT; ctx.stroke();
    for (let i = 0; i < 4; i++) { rr(ctx, -64 + i * 32, -168, 32, 92, 15); ctx.fillStyle = skin(ctx, -64 + i * 32, -32 + i * 32); ctx.fill(); ctx.stroke(); }
    ctx.save(); ctx.translate(-70, -62); ctx.rotate(-0.12); rr(ctx, 0, -18, 110, 38, 19); ctx.fillStyle = skin(ctx, 0, 110); ctx.fill(); ctx.stroke(); ctx.restore();
  }
  function paper(ctx, x, y, w, h, rot, shade, lines = 3) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    ctx.fillStyle = shade || '#eeeeee'; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = '#7d7d7d'; ctx.lineWidth = 2; ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = '#9a9a9a'; ctx.lineWidth = 3;
    for (let i = 0; i < lines; i++) { const yy = -h / 2 + (i + 1) * h / (lines + 1); ctx.beginPath(); ctx.moveTo(-w / 2 + 10, yy); ctx.lineTo(w / 2 - 10 - (i % 2) * w * 0.25, yy); ctx.stroke(); }
    ctx.restore();
  }
  function jagged(ctx, cx, cy, rw, rh, rnd, n = 26) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2, k = 0.86 + rnd() * 0.16;
      const x = cx + Math.cos(a) * rw * k * (Math.abs(Math.cos(a)) > 0.7 ? 1.05 : 1), y = cy + Math.sin(a) * rh * k;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  }
  function reliefCircle(ctx, x, y, r, rnd, dark, light) {
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) { const a = i / 64 * Math.PI * 2, k = r * (0.97 + rnd() * 0.05); ctx.lineTo(x + Math.cos(a) * k, y + Math.sin(a) * k); }
    ctx.closePath(); ctx.fillStyle = rad(ctx, x - r * 0.3, y - r * 0.3, r * 0.1, r * 1.1, [light, '#9a9a9a', dark]); ctx.fill();
  }
  function emboss(ctx, draw) {
    ctx.save(); ctx.translate(4, 4); ctx.strokeStyle = '#2a2a2a'; ctx.fillStyle = '#3a3a3a'; draw(); ctx.restore();
    ctx.save(); ctx.strokeStyle = '#e8e8e8'; ctx.fillStyle = '#bdbdbd'; draw(); ctx.restore();
  }

  const P = {};
  P.coin = () => {
    const [c, x] = mk(800, 800), rnd = E.rng('coin');
    reliefCircle(x, 400, 400, 390, rnd, '#4a4a4a', '#e0e0e0');
    x.lineWidth = 10; x.strokeStyle = '#5a5a5a'; x.beginPath(); x.arc(400, 400, 330, 0, 7); x.stroke();
    for (let i = 0; i < 70; i++) { const a = i / 70 * Math.PI * 2; x.fillStyle = '#444'; x.beginPath(); x.arc(400 + Math.cos(a) * 358, 400 + Math.sin(a) * 358, 7, 0, 7); x.fill(); }
    emboss(x, () => {
      x.lineWidth = 16; x.beginPath(); x.arc(330, 500, 120, 0, 7); x.stroke();
      for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; x.lineWidth = 9; x.beginPath(); x.moveTo(330, 500); x.lineTo(330 + Math.cos(a) * 118, 500 + Math.sin(a) * 118); x.stroke(); }
      x.beginPath(); x.moveTo(250, 380); x.lineTo(520, 360); x.lineTo(540, 460); x.lineTo(300, 470); x.closePath(); x.fill();
      x.beginPath(); x.arc(420, 230, 46, 0, 7); x.fill();
      x.beginPath(); x.moveTo(390, 270); x.lineTo(460, 270); x.lineTo(480, 370); x.lineTo(370, 370); x.closePath(); x.fill();
      x.lineWidth = 14; x.beginPath(); x.moveTo(460, 300); x.lineTo(600, 250); x.stroke();
      x.beginPath(); x.moveTo(540, 470); x.quadraticCurveTo(640, 420, 620, 300); x.stroke();
    });
    return { canvas: c };
  };
  P.token = () => { const [c, x] = mk(200, 200), rnd = E.rng('tok'); reliefCircle(x, 100, 100, 92, rnd, '#666', '#eee'); x.lineWidth = 6; x.strokeStyle = '#777'; x.beginPath(); x.arc(100, 100, 70, 0, 7); x.stroke(); return { canvas: c }; };
  P.seal = () => {
    const [c, x] = mk(800, 800), rnd = E.rng('seal');
    jagged(x, 400, 400, 380, 370, rnd, 40); x.fillStyle = rad(x, 330, 330, 20, 420, ['#8a8a8a', '#4a4a4a', '#222']); x.fill();
    x.lineWidth = 22; x.strokeStyle = '#9d9d9d'; x.beginPath(); x.arc(400, 400, 255, 0, 7); x.stroke();
    x.lineWidth = 8; x.strokeStyle = '#1e1e1e'; x.beginPath(); x.arc(404, 404, 270, 0, 7); x.stroke();
    const letter = (V.brand.name || 'B')[0].toUpperCase();
    x.font = "bold 320px Georgia, 'Times New Roman', serif"; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#1f1f1f'; x.fillText(letter, 408, 418); x.fillStyle = '#9b9b9b'; x.fillText(letter, 400, 408);
    return { canvas: c };
  };
  P.watch = () => {
    const [c, x] = mk(760, 900);
    x.lineWidth = 26; x.strokeStyle = lin(x, 300, 0, 460, 0, ['#999', '#f2f2f2', '#666']); x.beginPath(); x.arc(380, 105, 72, 0, 7); x.stroke();
    x.fillStyle = lin(x, 340, 0, 420, 0, ['#777', '#eee', '#555']); rr(x, 342, 150, 76, 70, 14); x.fill();
    x.beginPath(); x.arc(380, 540, 350, 0, 7); x.fillStyle = lin(x, 30, 200, 730, 890, ['#fafafa', '#8f8f8f', '#e6e6e6', '#555']); x.fill();
    x.beginPath(); x.arc(380, 540, 305, 0, 7); x.fillStyle = rad(x, 330, 480, 20, 330, ['#fbfbf8', '#ecebe6', '#cfcdc6']); x.fill();
    x.strokeStyle = '#222';
    for (let i = 0; i < 60; i++) { const a = i / 60 * Math.PI * 2, r0 = i % 5 ? 282 : 268; x.lineWidth = i % 5 ? 3 : 7; x.beginPath(); x.moveTo(380 + Math.cos(a) * r0, 540 + Math.sin(a) * r0); x.lineTo(380 + Math.cos(a) * 296, 540 + Math.sin(a) * 296); x.stroke(); }
    x.fillStyle = '#1a1a1a'; x.font = "48px Georgia, 'Times New Roman', serif"; x.textAlign = 'center'; x.textBaseline = 'middle';
    for (let h = 1; h <= 12; h++) { const a = (h / 12) * Math.PI * 2 - Math.PI / 2; x.fillText(String(h), 380 + Math.cos(a) * 225, 540 + Math.sin(a) * 225); }
    x.beginPath(); x.arc(380, 690, 55, 0, 7); x.lineWidth = 3; x.stroke();
    x.lineCap = 'round';
    x.lineWidth = 14; x.beginPath(); x.moveTo(380, 540); x.lineTo(380 + 120, 540 + 70); x.stroke();
    x.lineWidth = 9; x.beginPath(); x.moveTo(380, 540); x.lineTo(380 - 40, 540 - 215); x.stroke();
    x.beginPath(); x.arc(380, 540, 16, 0, 7); x.fill();
    return { canvas: c };
  };
  P.bell = () => {
    const [c, x] = mk(720, 860);
    x.fillStyle = lin(x, 0, 30, 0, 90, ['#666', '#222']); rr(x, 180, 30, 360, 50, 12); x.fill();
    x.lineWidth = 22; x.strokeStyle = '#333'; x.beginPath(); x.moveTo(250, 80); x.lineTo(270, 150); x.moveTo(470, 80); x.lineTo(450, 150); x.stroke();
    const body = () => { x.beginPath(); x.moveTo(265, 150); x.bezierCurveTo(250, 330, 170, 470, 50, 660); x.quadraticCurveTo(30, 700, 40, 715); x.lineTo(680, 715); x.quadraticCurveTo(690, 700, 670, 660); x.bezierCurveTo(550, 470, 470, 330, 455, 150); x.closePath(); };
    body(); x.fillStyle = lin(x, 40, 0, 680, 0, ['#262626', '#6b6b6b', '#f4f4f4', '#bdbdbd', '#7a7a7a', '#303030', '#9a9a9a', '#1a1a1a']); x.fill();
    x.beginPath(); x.ellipse(360, 152, 96, 40, 0, 0, 7); x.fillStyle = lin(x, 264, 0, 456, 0, ['#444', '#ddd', '#555']); x.fill();
    [[600, 0.8], [640, 0.9]].forEach(([y]) => { x.beginPath(); x.moveTo(58, y); x.quadraticCurveTo(360, y + 30, 662, y); x.lineWidth = 6; x.strokeStyle = 'rgba(20,20,20,0.6)'; x.stroke(); });
    x.beginPath(); x.ellipse(360, 715, 322, 52, 0, 0, 7); x.fillStyle = '#121212'; x.fill(); x.lineWidth = 12; x.strokeStyle = '#cfcfcf'; x.stroke();
    x.beginPath(); x.arc(380, 760, 34, 0, 7); x.fillStyle = rad(x, 370, 750, 4, 40, ['#aaa', '#222']); x.fill();
    return { canvas: c };
  };
  P.envelope = () => {
    const [c, x] = mk(820, 540);
    x.fillStyle = lin(x, 0, 0, 0, 540, ['#fbfbfb', '#dedede']); x.fillRect(10, 10, 800, 520);
    x.strokeStyle = '#9a9a9a'; x.lineWidth = 3; x.strokeRect(10, 10, 800, 520);
    x.beginPath(); x.moveTo(10, 10); x.lineTo(410, 300); x.lineTo(810, 10); x.fillStyle = lin(x, 0, 10, 0, 300, ['#f0f0f0', '#d6d6d6']); x.fill(); x.stroke();
    x.beginPath(); x.moveTo(10, 530); x.lineTo(330, 250); x.moveTo(810, 530); x.lineTo(490, 250); x.strokeStyle = '#bbb'; x.stroke();
    return { canvas: c };
  };
  P.card = () => {
    const [c, x] = mk(540, 720);
    x.fillStyle = lin(x, 0, 0, 540, 720, ['#ffffff', '#e2e2e2']); x.fillRect(10, 10, 520, 700); x.strokeStyle = '#a5a5a5'; x.lineWidth = 3; x.strokeRect(10, 10, 520, 700);
    x.beginPath(); x.moveTo(150, 560); x.bezierCurveTo(200, 480, 230, 620, 270, 540); x.bezierCurveTo(300, 480, 320, 600, 390, 520); x.strokeStyle = '#222'; x.lineWidth = 6; x.stroke();
    return { canvas: c };
  };
  P.gridcard = () => {
    const [c, x] = mk(540, 720);
    x.fillStyle = lin(x, 0, 0, 540, 720, ['#ffffff', '#dddddd']); x.fillRect(10, 10, 520, 700); x.strokeStyle = '#999'; x.lineWidth = 4; x.strokeRect(10, 10, 520, 700);
    x.beginPath(); x.moveTo(270, 10); x.lineTo(270, 710); [243, 476].forEach((y) => { x.moveTo(10, y); x.lineTo(530, y); }); x.stroke();
    return { canvas: c };
  };
  P.quill = () => {
    const [c, x] = mk(180, 860);
    x.beginPath(); x.moveTo(60, 20); x.lineTo(120, 20); x.lineTo(130, 560); x.lineTo(90, 700); x.lineTo(50, 560); x.closePath(); x.fillStyle = lin(x, 50, 0, 130, 0, ['#111', '#555', '#0a0a0a']); x.fill();
    x.beginPath(); x.moveTo(62, 600); x.lineTo(118, 600); x.lineTo(92, 840); x.closePath(); x.fillStyle = lin(x, 60, 0, 120, 0, ['#777', '#eee', '#555']); x.fill();
    x.beginPath(); x.moveTo(90, 660); x.lineTo(92, 835); x.strokeStyle = '#222'; x.lineWidth = 3; x.stroke();
    return { canvas: c };
  };
  P.wheat = () => {
    const [c, x] = mk(300, 860);
    x.beginPath(); x.moveTo(160, 850); x.quadraticCurveTo(140, 500, 150, 120); x.strokeStyle = '#6d6d6d'; x.lineWidth = 7; x.stroke();
    for (let i = 0; i < 12; i++) {
      const y = 140 + i * 34, side = i % 2 ? 1 : -1;
      x.save(); x.translate(150 + side * 14, y); x.rotate(side * 0.5); x.beginPath(); x.ellipse(0, 0, 16, 34, 0, 0, 7); x.fillStyle = lin(x, -16, 0, 16, 0, ['#ddd', '#8a8a8a']); x.fill(); x.strokeStyle = '#555'; x.lineWidth = 2; x.stroke();
      x.beginPath(); x.moveTo(0, -30); x.lineTo(side * 20, -110); x.strokeStyle = '#888'; x.stroke(); x.restore();
    }
    return { canvas: c };
  };
  P.thumb = () => {
    const [c, x] = mk(760, 560);
    x.save(); x.translate(470, 330);
    x.fillStyle = lin(x, 0, -80, 0, 80, ['#3a3a3a', '#161616', '#444']); x.fillRect(40, -85, 260, 170);
    x.fillStyle = '#f2f2f2'; x.fillRect(20, -78, 34, 156);
    rr(x, -250, -70, 280, 150, 44); x.fillStyle = lin(x, 0, -70, 0, 80, SKIN); x.fill(); x.lineWidth = 3; x.strokeStyle = OUT; x.stroke();
    for (let i = 0; i < 4; i++) { rr(x, -262, -40 + i * 30, 150, 32, 16); x.fillStyle = lin(x, -262, 0, -110, 0, SKIN); x.fill(); x.stroke(); }
    x.restore();
    capsule(x, 270, 270, 190, 58, -8);
    return { canvas: c };
  };
  P.hand = () => { const [c, x] = mk(420, 820); x.translate(210, 380); openHand(x, { sleeveLen: 150 }); return { canvas: c }; };
  P.palm = () => { const [c, x] = mk(460, 900); x.translate(230, 420); x.scale(1.1, 1.1); openHand(x, { sleeveLen: 230, shade: '#5a5a5a' }); return { canvas: c }; };
  P.fist = () => { const [c, x] = mk(420, 900); x.translate(210, 250); x.rotate(0.12); fist(x, { sleeveLen: 420 }); return { canvas: c }; };
  P.cash = () => {
    const [c, x] = mk(640, 760);
    for (let i = 0; i < 6; i++) paper(x, 300 + (i - 3) * 22, 230 - i * 6, 200, 330, -0.5 + i * 0.2, i % 2 ? '#e6e6e6' : '#d2d2d2', 2);
    x.save(); x.translate(310, 470); fist(x, { sleeveLen: 300 }); x.restore();
    return { canvas: c };
  };
  P.crowd = () => {
    const [c, x] = mk(1100, 1100), rnd = E.rng('crowd');
    const arms = 7;
    for (let i = 0; i < arms; i++) {
      const bx = 90 + i * 150 + rnd() * 40, ang = -0.5 + i * 0.12 + (rnd() - 0.5) * 0.25, L = 430 + rnd() * 330;
      x.save(); x.translate(bx, 1150); x.rotate(ang);
      x.save(); x.translate(0, -L);
      openHand(x, { sleeveLen: L + 60, shade: ['#7c7c7c', '#5e5e5e', '#8e8e8e'][i % 3] });
      paper(x, (rnd() - 0.5) * 60, -300, 150, 200, (rnd() - 0.5) * 0.6, '#f3f3f3', 3);
      x.restore(); x.restore();
    }
    return { canvas: c };
  };
  P.pile = () => {
    const [c, x] = mk(1100, 760), rnd = E.rng('pile');
    const items = [];
    for (let i = 0; i < 90; i++) { const dx = (rnd() * 2 - 1); const top = (1 - dx * dx) * 430; items.push({ x: 550 + dx * 500, y: 740 - rnd() * top, w: 100 + rnd() * 110, h: 70 + rnd() * 80, r: (rnd() - 0.5) * 1.4, s: ['#f0f0f0', '#dadada', '#c4c4c4', '#e8e8e8'][i % 4] }); }
    items.sort((a, b) => b.y - a.y).forEach((p) => paper(x, p.x, p.y, p.w, p.h, p.r, p.s, 2));
    return { canvas: c };
  };
  P.ribbon = () => {
    const [c, x] = mk(900, 420);
    let prev = null;
    for (let t = 0; t <= 1.0001; t += 0.004) {
      const px = 40 + t * 820, py = 210 + Math.sin(t * 9) * 110 + t * 40, tw = Math.cos(t * 13);
      const dx = 820, dy = Math.cos(t * 9) * 9 * 110 + 40, n = Math.hypot(dx, dy), nx = -dy / n, ny = dx / n, hw = 8 + 30 * Math.abs(tw);
      const cur = [px + nx * hw, py + ny * hw, px - nx * hw, py - ny * hw];
      if (prev) { x.beginPath(); x.moveTo(prev[0], prev[1]); x.lineTo(cur[0], cur[1]); x.lineTo(cur[2], cur[3]); x.lineTo(prev[2], prev[3]); x.closePath(); const g = tw > 0 ? 235 - 40 * (1 - tw) : 170 + 40 * tw; x.fillStyle = `rgb(${g},${g},${g})`; x.fill(); }
      prev = cur;
    }
    return { canvas: c };
  };
  P.map = () => {
    const [c, x] = mk(720, 520), rnd = E.rng('map');
    jagged(x, 360, 260, 330, 230, rnd, 34); x.fillStyle = '#ececec'; x.fill(); x.strokeStyle = '#777'; x.lineWidth = 3; x.stroke();
    x.save(); x.clip(); x.strokeStyle = '#8a8a8a'; x.lineWidth = 3;
    for (let i = 0; i < 9; i++) { x.beginPath(); x.moveTo(0, 30 + i * 60 + i * 4); x.lineTo(720, 10 + i * 60); x.stroke(); }
    for (let i = 0; i < 6; i++) { x.beginPath(); x.moveTo(60 + i * 120, 0); x.lineTo(40 + i * 125, 520); x.stroke(); }
    x.restore();
    return { canvas: c };
  };
  P.door = () => {
    const [c, x] = mk(520, 720);
    x.fillStyle = lin(x, 0, 0, 520, 0, ['#d8d8d8', '#bcbcbc', '#e2e2e2']); x.fillRect(10, 10, 500, 700);
    x.strokeStyle = '#8a8a8a'; x.lineWidth = 3;
    for (let y = 10; y < 710; y += 58) { x.beginPath(); x.moveTo(10, y); x.lineTo(510, y); x.stroke(); }
    x.fillStyle = lin(x, 130, 0, 390, 0, ['#050505', '#262626', '#0a0a0a']); x.fillRect(135, 140, 250, 570);
    x.fillStyle = '#9d9d9d'; x.fillRect(100, 100, 320, 44);
    return { canvas: c };
  };
  P.column = () => {
    const [c, x] = mk(760, 520);
    x.fillStyle = lin(x, 0, 40, 0, 110, ['#eee', '#aaa']); x.fillRect(60, 40, 640, 70);
    x.fillStyle = lin(x, 0, 110, 0, 220, ['#ddd', '#999']); x.fillRect(150, 110, 460, 110);
    [170, 590].forEach((cx) => { for (let r = 90; r > 10; r -= 16) { x.beginPath(); x.arc(cx, 190, r, 0, 7); x.fillStyle = r % 32 ? '#cfcfcf' : '#8a8a8a'; x.fill(); } });
    x.fillStyle = lin(x, 210, 0, 550, 0, ['#9a9a9a', '#eeeeee', '#8a8a8a']); x.fillRect(210, 220, 340, 290);
    x.strokeStyle = '#6a6a6a'; x.lineWidth = 5; for (let i = 0; i < 8; i++) { x.beginPath(); x.moveTo(232 + i * 42, 230); x.lineTo(232 + i * 42, 510); x.stroke(); }
    return { canvas: c };
  };
  P.scrap = (name) => {
    const [c, x] = mk(460, 560), rnd = E.rng(name || 'scrap');
    jagged(x, 230, 280, 200, 250, rnd, 22); x.fillStyle = lin(x, 0, 0, 460, 560, ['#f3f3f3', '#cfcfcf']); x.fill(); x.strokeStyle = '#777'; x.lineWidth = 3; x.stroke();
    x.save(); x.clip(); x.strokeStyle = '#8d8d8d'; x.lineWidth = 5;
    for (let i = 0; i < 9; i++) { x.beginPath(); x.moveTo(40, 80 + i * 48); x.bezierCurveTo(150, 60 + i * 48 + rnd() * 30, 300, 100 + i * 48, 420, 80 + i * 48); x.stroke(); }
    x.restore();
    return { canvas: c };
  };
  // CRT monitor. Screen content is layered on top in the DOM at MONITOR_SCREEN.
  E.MONITOR_SCREEN = [0.13, 0.1221, 0.74, 0.6163];
  P.monitor = () => {
    const [c, x] = mk(1000, 860);
    x.fillStyle = lin(x, 0, 740, 0, 850, ['#bdbbb4', '#8c8a84']); x.beginPath(); x.moveTo(300, 740); x.lineTo(700, 740); x.lineTo(760, 850); x.lineTo(240, 850); x.closePath(); x.fill();
    rr(x, 40, 20, 920, 730, 56); x.fillStyle = lin(x, 0, 20, 1000, 760, ['#f4f3ee', '#d4d2cb', '#aeaca5']); x.fill(); x.lineWidth = 4; x.strokeStyle = '#8a8882'; x.stroke();
    rr(x, 95, 65, 810, 600, 44); x.fillStyle = lin(x, 0, 65, 0, 665, ['#c9c7c0', '#e6e4de']); x.fill(); x.strokeStyle = '#9d9b94'; x.lineWidth = 3; x.stroke();
    rr(x, 130, 105, 740, 530, 34); x.fillStyle = '#101010'; x.fill();
    x.strokeStyle = '#9a988f'; x.lineWidth = 5; for (let i = 0; i < 7; i++) { x.beginPath(); x.moveTo(640 + i * 30, 695); x.lineTo(640 + i * 30, 725); x.stroke(); }
    x.beginPath(); x.arc(170, 705, 16, 0, 7); x.fillStyle = '#8f8d86'; x.fill();
    return { canvas: c, opts: { trim: false, key: false, halftoneAmount: 0.25 } };
  };
  // A hand holding a phone. The phone screen is painted in color after halftoning.
  P.phone = () => {
    const [c, x] = mk(700, 1100);
    x.save(); x.translate(470, 1180); x.rotate(-0.55);
    x.fillStyle = lin(x, -130, 0, 130, 0, ['#8a8a8a', '#5c5c5c', '#9a9a9a']); x.fillRect(-130, -520, 260, 560);
    x.strokeStyle = 'rgba(40,40,40,0.5)'; x.lineWidth = 4; for (let y = -500; y < 30; y += 22) { x.beginPath(); x.moveTo(-130, y); x.lineTo(130, y + 6); x.stroke(); }
    x.restore();
    x.beginPath(); x.ellipse(350, 820, 150, 200, -0.2, 0, 7); x.fillStyle = lin(x, 200, 0, 500, 0, SKIN); x.fill(); x.strokeStyle = OUT; x.lineWidth = 3; x.stroke();
    x.save(); x.translate(350, 420); x.rotate(0.06);
    rr(x, -150, -330, 300, 620, 42); x.fillStyle = '#0d0d0d'; x.fill(); x.strokeStyle = '#555'; x.lineWidth = 4; x.stroke();
    x.restore();
    [[520, 350], [528, 430], [522, 510], [505, 585]].forEach(([fx, fy]) => { x.beginPath(); x.ellipse(fx, fy, 46, 33, 0.2, 0, 7); x.fillStyle = lin(x, fx - 46, 0, fx + 46, 0, SKIN); x.fill(); x.strokeStyle = OUT; x.stroke(); });
    capsule(x, 215, 760, 200, 64, -18);
    const after = (ctx) => {
      ctx.save(); ctx.translate(350, 420); ctx.rotate(0.06);
      rr(ctx, -134, -312, 268, 584, 30); ctx.fillStyle = '#05070c'; ctx.fill(); ctx.clip();
      const rnd = E.rng('phone');
      ctx.fillStyle = V.brand.color;
      for (let i = 0; i < 26; i++) { const y = -270 + i * 20, w = 30 + rnd() * 150; ctx.globalAlpha = 0.55 + rnd() * 0.45; ctx.fillRect(-110 + (i % 2 ? 0 : 20), y, w * (i < 13 ? 1 : 0.7), 12); }
      ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.fillRect(-110, -300, 60, 10);
      ctx.restore();
    };
    return { canvas: c, after, opts: { trim: false, key: false } };
  };

  /* ----- identity & privacy ----- */
  P.idcard = () => {
    const [c, x] = mk(840, 540), rnd = E.rng('idcard');
    rr(x, 10, 10, 820, 520, 34); x.fillStyle = lin(x, 0, 0, 840, 540, ['#fbfbfb', '#dcdcdc']); x.fill(); x.strokeStyle = '#8f8f8f'; x.lineWidth = 4; x.stroke();
    x.save(); x.clip(); x.fillStyle = '#9d9d9d'; x.fillRect(10, 10, 820, 86); x.restore();
    x.fillStyle = '#f2f2f2'; x.fillRect(40, 40, 300, 22); x.fillRect(560, 40, 230, 22);
    rr(x, 44, 130, 230, 290, 12); x.fillStyle = '#cfcfcf'; x.fill();
    x.save(); x.beginPath(); x.roundRect(44, 130, 230, 290, 12); x.clip();
    x.fillStyle = '#3b3b3b'; x.beginPath(); x.arc(159, 240, 62, 0, 7); x.fill(); x.beginPath(); x.ellipse(159, 420, 110, 110, 0, Math.PI, 0); x.fill(); x.restore();
    x.fillStyle = '#4a4a4a'; [[310, 150, 330], [310, 200, 260], [310, 262, 380], [310, 312, 300], [310, 362, 220]].forEach(([a, b, w]) => x.fillRect(a, b, w, 20));
    for (let i = 0, bx = 60; bx < 780; i++) { const w = 3 + Math.floor(rnd() * 3) * 3; x.fillStyle = '#222'; if (i % 2 === 0) x.fillRect(bx, 452, w, 48); bx += w + 2; }
    x.beginPath(); x.arc(740, 330, 44, 0, 7); x.fillStyle = rad(x, 725, 315, 4, 50, ['#fafafa', '#b3b3b3', '#8a8a8a']); x.fill();
    return { canvas: c };
  };
  P.creditcard = () => {
    const [c, x] = mk(840, 540);
    rr(x, 10, 10, 820, 520, 38); x.fillStyle = lin(x, 0, 0, 840, 540, ['#6b6b6b', '#2e2e2e', '#474747', '#1c1c1c']); x.fill();
    x.save(); x.clip(); x.fillStyle = 'rgba(255,255,255,0.08)'; x.beginPath(); x.ellipse(620, -40, 420, 260, -0.3, 0, 7); x.fill(); x.restore();
    rr(x, 90, 170, 130, 100, 16); x.fillStyle = lin(x, 90, 170, 220, 270, ['#e8e8e8', '#9a9a9a', '#d6d6d6']); x.fill();
    x.strokeStyle = '#6a6a6a'; x.lineWidth = 3; x.beginPath(); x.moveTo(90, 220); x.lineTo(220, 220); x.moveTo(155, 170); x.lineTo(155, 270); x.moveTo(120, 170); x.lineTo(120, 270); x.moveTo(190, 170); x.lineTo(190, 270); x.stroke();
    x.strokeStyle = '#d0d0d0'; x.lineWidth = 7; x.lineCap = 'round'; [30, 52, 74].forEach((r) => { x.beginPath(); x.arc(270, 220, r, -0.7, 0.7); x.stroke(); });
    x.fillStyle = '#e6e6e6'; x.font = "600 58px 'Courier New', monospace"; x.textBaseline = 'middle'; x.fillText('•••• •••• •••• 4821', 80, 350);
    x.fillStyle = '#bdbdbd'; x.fillRect(80, 430, 280, 22); x.fillRect(440, 430, 90, 22);
    x.globalAlpha = 0.85; x.fillStyle = '#d9d9d9'; x.beginPath(); x.arc(680, 440, 52, 0, 7); x.fill(); x.fillStyle = '#9a9a9a'; x.beginPath(); x.arc(745, 440, 52, 0, 7); x.fill(); x.globalAlpha = 1;
    return { canvas: c };
  };
  P.email = () => {
    const made = P.envelope(), x = made.canvas.getContext('2d');
    x.beginPath(); x.arc(600, 360, 128, 0, 7); x.fillStyle = '#f7f7f7'; x.fill(); x.lineWidth = 10; x.strokeStyle = '#2a2a2a'; x.stroke();
    x.fillStyle = '#1e1e1e'; x.font = "bold 180px Georgia, 'Times New Roman', serif"; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('@', 600, 372);
    return made;
  };
  P.camera = () => {
    const [c, x] = mk(940, 640);
    x.fillStyle = lin(x, 0, 0, 90, 0, ['#9a9a9a', '#e0e0e0', '#8a8a8a']); rr(x, 20, 120, 90, 300, 12); x.fill();
    x.fillStyle = lin(x, 0, 250, 0, 300, ['#bbb', '#6a6a6a']); x.beginPath(); x.moveTo(100, 250); x.lineTo(300, 300); x.lineTo(300, 350); x.lineTo(100, 300); x.closePath(); x.fill();
    x.save(); x.translate(300, 250); x.rotate(0.22);
    rr(x, 0, -40, 520, 190, 36); x.fillStyle = lin(x, 0, -40, 0, 150, ['#f4f4f4', '#cfcfcf', '#8e8e8e']); x.fill(); x.lineWidth = 4; x.strokeStyle = '#5e5e5e'; x.stroke();
    x.fillStyle = lin(x, 0, -70, 0, -30, ['#e0e0e0', '#9a9a9a']); rr(x, -10, -72, 580, 48, 18); x.fill(); x.stroke();
    rr(x, 470, -30, 120, 170, 24); x.fillStyle = '#1b1b1b'; x.fill();
    x.beginPath(); x.arc(530, 55, 54, 0, 7); x.fillStyle = rad(x, 515, 40, 4, 60, ['#8a8a8a', '#2a2a2a', '#050505']); x.fill();
    x.beginPath(); x.arc(512, 36, 14, 0, 7); x.fillStyle = '#e8e8e8'; x.fill();
    x.beginPath(); x.arc(80, 90, 14, 0, 7); x.fillStyle = '#3a3a3a'; x.fill();
    x.restore();
    return { canvas: c };
  };
  P.fingerprint = () => {
    const [c, x] = mk(620, 760), rnd = E.rng('fp');
    x.strokeStyle = '#1c1c1c'; x.lineCap = 'round'; x.lineWidth = 13;
    for (let i = 0; i < 15; i++) {
      const rx = 24 + i * 19, ry = 34 + i * 23, cx = 310 + Math.sin(i * 0.7) * 6, cy = 400 - i * 4;
      let a = -Math.PI * 1.05 + rnd() * 0.3;
      const end = Math.PI * 0.08 + (i < 4 ? Math.PI * 1.1 : rnd() * 0.3);
      while (a < end) { const seg = 0.5 + rnd() * 1.4; x.beginPath(); x.ellipse(cx, cy, rx, ry, 0, a, Math.min(end, a + seg)); x.stroke(); a += seg + 0.12 + rnd() * 0.2; }
    }
    return { canvas: c };
  };
  /* ----- classical order ----- */
  P.amphora = () => {
    const [c, x] = mk(600, 940);
    const half = [[0, 40], [70, 40], [66, 70], [58, 190], [150, 300], [214, 430], [206, 560], [150, 700], [80, 800], [60, 850], [110, 900], [0, 900]];
    const shape = () => { x.beginPath(); x.moveTo(300, 40); half.forEach(([dx, y]) => x.lineTo(300 + dx, y)); [...half].reverse().forEach(([dx, y]) => x.lineTo(300 - dx, y)); x.closePath(); };
    x.lineWidth = 26; x.strokeStyle = '#3a3a3a'; x.lineCap = 'round';
    [[1], [-1]].forEach(([k]) => { x.beginPath(); x.moveTo(300 + k * 62, 110); x.bezierCurveTo(300 + k * 190, 80, 300 + k * 200, 250, 300 + k * 150, 300); x.stroke(); });
    shape(); x.fillStyle = lin(x, 90, 0, 520, 0, ['#5a5a5a', '#bdbdbd', '#e4e4e4', '#9a9a9a', '#3e3e3e']); x.fill();
    x.save(); shape(); x.clip();
    x.fillStyle = '#1e1e1e'; x.fillRect(0, 330, 600, 150); x.fillRect(0, 640, 600, 26); x.fillRect(0, 185, 600, 18);
    x.strokeStyle = '#cfcfcf'; x.lineWidth = 8; x.lineCap = 'butt';
    for (let k = 60; k < 560; k += 70) { x.beginPath(); x.moveTo(k, 450); x.lineTo(k, 360); x.lineTo(k + 50, 360); x.lineTo(k + 50, 420); x.lineTo(k + 22, 420); x.lineTo(k + 22, 392); x.stroke(); }
    x.restore();
    return { canvas: c };
  };
  P.mask = () => {
    const [c, x] = mk(720, 860);
    x.strokeStyle = '#6a6a6a'; x.lineWidth = 16; x.lineCap = 'round';
    [[1], [-1]].forEach(([k]) => { x.beginPath(); x.moveTo(360 + k * 250, 300); x.bezierCurveTo(360 + k * 330, 420, 360 + k * 290, 620, 360 + k * 340, 820); x.stroke(); });
    x.beginPath(); x.moveTo(360, 40); x.bezierCurveTo(600, 40, 650, 260, 610, 420); x.bezierCurveTo(580, 620, 470, 780, 360, 790); x.bezierCurveTo(250, 780, 140, 620, 110, 420); x.bezierCurveTo(70, 260, 120, 40, 360, 40); x.closePath();
    x.fillStyle = lin(x, 100, 0, 620, 0, ['#9e9e9e', '#f2f2f2', '#fafafa', '#cfcfcf', '#7e7e7e']); x.fill(); x.lineWidth = 4; x.strokeStyle = '#555'; x.stroke();
    x.fillStyle = '#0e0e0e';
    [[1], [-1]].forEach(([k]) => { x.beginPath(); x.ellipse(360 + k * 125, 330, 78, 40, k * 0.18, 0, 7); x.fill(); });
    x.strokeStyle = '#6a6a6a'; x.lineWidth = 10;
    [[1], [-1]].forEach(([k]) => { x.beginPath(); x.moveTo(360 + k * 40, 250); x.quadraticCurveTo(360 + k * 130, 200, 360 + k * 220, 250); x.stroke(); });
    x.beginPath(); x.moveTo(360, 300); x.lineTo(345, 480); x.quadraticCurveTo(360, 500, 385, 480); x.stroke();
    x.beginPath(); x.moveTo(250, 590); x.quadraticCurveTo(360, 690, 470, 590); x.quadraticCurveTo(360, 640, 250, 590); x.fillStyle = '#0e0e0e'; x.fill();
    return { canvas: c };
  };
  P.laurel = () => {
    const [c, x] = mk(920, 560);
    [[1], [-1]].forEach(([k]) => {
      x.strokeStyle = '#555'; x.lineWidth = 9; x.beginPath(); x.moveTo(460, 520); x.quadraticCurveTo(460 + k * 420, 470, 460 + k * 360, 60); x.stroke();
      for (let i = 0; i < 12; i++) {
        const t = 0.08 + i * 0.075, px = 460 + k * (2 * (1 - t) * t * 420 + t * t * 360), py = (1 - t) * (1 - t) * 520 + 2 * (1 - t) * t * 470 + t * t * 60;
        [-1, 1].forEach((side) => {
          x.save(); x.translate(px, py); x.rotate(k * (0.9 - t * 1.2) + side * 0.7 * k - (k < 0 ? Math.PI : 0) * 0);
          x.beginPath(); x.ellipse(side * 30, 0, 40, 15, 0, 0, 7); x.fillStyle = lin(x, -40, -15, 40, 15, ['#d9d9d9', '#8a8a8a']); x.fill(); x.lineWidth = 2; x.strokeStyle = '#4a4a4a'; x.stroke(); x.restore();
        });
      }
    });
    x.fillStyle = '#3a3a3a'; x.beginPath(); x.moveTo(430, 500); x.lineTo(490, 500); x.lineTo(520, 555); x.lineTo(460, 525); x.lineTo(400, 555); x.closePath(); x.fill();
    return { canvas: c };
  };
  P.scroll = () => {
    const [c, x] = mk(940, 440), rnd = E.rng('scroll');
    x.fillStyle = lin(x, 0, 60, 0, 380, ['#f4f4f0', '#dadad4']); x.fillRect(90, 70, 760, 300);
    x.strokeStyle = '#8a8a8a'; x.lineWidth = 5;
    for (let i = 0; i < 7; i++) { const y = 110 + i * 36; x.beginPath(); x.moveTo(140, y); x.lineTo(140 + 560 + rnd() * 100 - (i === 6 ? 300 : 0), y); x.stroke(); }
    [[60, 1], [880, -1]].forEach(([cx]) => { rr(x, cx - 44, 40, 88, 360, 44); x.fillStyle = lin(x, cx - 44, 0, cx + 44, 0, ['#8e8e8e', '#f0f0ec', '#b5b5b0', '#6a6a6a']); x.fill(); x.lineWidth = 3; x.strokeStyle = '#555'; x.stroke(); x.beginPath(); x.ellipse(cx, 44, 44, 14, 0, 0, 7); x.fillStyle = '#cfcfc9'; x.fill(); x.stroke(); });
    return { canvas: c };
  };

  // Projects can add their own procedural props: E.defineStandIn('name', () => ({ canvas })).
  E.draw = { mk, lin, rad, rr, capsule, sleeve, openHand, fist, paper, jagged, reliefCircle, emboss, SKIN, OUT };
  E.defineStandIn = (name, fn) => { P[name] = fn; };

  E.standInProp = function (name) {
    const f = P[name] || (name.startsWith('hand') ? P.hand : null);
    const made = f ? f(name) : P.scrap(name);
    return made;
  };
  Object.defineProperty(E, 'STANDIN_PROPS', { get: () => Object.keys(P) });

  /* ---------- screens: dark trading-app mockups ---------- */
  const S = {};
  const MONO = "'SF Mono', Menlo, Consolas, monospace";
  function uiText(x, str, px, py, size, color, weight, align, font) {
    x.font = `${weight || 500} ${size}px ${font || V.brand.font}`; x.fillStyle = color; x.textAlign = align || 'left'; x.textBaseline = 'middle'; x.fillText(str, px, py);
  }
  function panel(x, px, py, w, h) { rr(x, px, py, w, h, 12); x.fillStyle = '#0d1016'; x.fill(); x.strokeStyle = '#1b202b'; x.lineWidth = 2; x.stroke(); }
  function header(x, W, active) {
    x.fillStyle = '#07090d'; x.fillRect(0, 0, W, 64); x.fillStyle = '#161a22'; x.fillRect(0, 63, W, 1);
    rr(x, 22, 18, 28, 28, 7); x.fillStyle = V.brand.color; x.fill();
    uiText(x, V.brand.name, 60, 32, 19, '#fff', 600);
    const nav = V.nav || ['Spot', 'Predict', 'Vault', 'Portfolio'];
    let nx = W * 0.36;
    nav.forEach((n) => {
      const label = n + ((V.navDropdowns || []).includes(n) ? ' ▾' : '');
      x.font = `500 17px ${V.brand.font}`; const w = x.measureText(label).width;
      if (n === active) { rr(x, nx - 10, 18, w + 20, 28, 7); x.fillStyle = V.brand.color; x.globalAlpha = 0.25; x.fill(); x.globalAlpha = 1; }
      uiText(x, label, nx, 32, 17, n === active ? '#fff' : '#9aa3b2', 500); nx += w + 34;
    });
    rr(x, W - 330, 16, 140, 32, 8); x.fillStyle = '#131722'; x.fill(); uiText(x, '$1,498.76', W - 260, 32, 15, '#cfd6e4', 500, 'center', MONO);
    rr(x, W - 175, 16, 150, 32, 8); x.fillStyle = '#131722'; x.fill(); uiText(x, '0x7a2…f3c1', W - 100, 32, 15, '#cfd6e4', 500, 'center', MONO);
  }
  function series(seed, n, start, vol) { const r = E.rng(seed); const out = [start]; for (let i = 1; i < n; i++) out.push(out[i - 1] + (r() - 0.47) * vol); return out; }
  function candles(x, px, py, w, h, n, seed, up, down) {
    const r = E.rng(seed); let v = 50; const bars = [];
    for (let i = 0; i < n; i++) { const o = v, cl = v + (r() - 0.45) * 8; const hi = Math.max(o, cl) + r() * 4, lo = Math.min(o, cl) - r() * 4; bars.push([o, cl, hi, lo]); v = cl; }
    const mn = Math.min(...bars.map((b) => b[3])), mx = Math.max(...bars.map((b) => b[2]));
    const Y = (val) => py + h - (val - mn) / (mx - mn) * h, bw = w / n;
    bars.forEach(([o, cl, hi, lo], i) => {
      const cx = px + i * bw + bw / 2, col = cl >= o ? up : down;
      x.strokeStyle = col; x.lineWidth = 1.5; x.beginPath(); x.moveTo(cx, Y(hi)); x.lineTo(cx, Y(lo)); x.stroke();
      x.fillStyle = col; x.fillRect(cx - bw * 0.32, Math.min(Y(o), Y(cl)), bw * 0.64, Math.max(2, Math.abs(Y(o) - Y(cl))));
    });
  }
  function line(x, px, py, w, h, vals, color, fill) {
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const pts = vals.map((v, i) => [px + i / (vals.length - 1) * w, py + h - (v - mn) / (mx - mn || 1) * h]);
    if (fill) { x.beginPath(); x.moveTo(pts[0][0], py + h); pts.forEach((p) => x.lineTo(p[0], p[1])); x.lineTo(px + w, py + h); x.closePath(); x.fillStyle = lin(x, 0, py, 0, py + h, [fill, 'rgba(0,0,0,0)']); x.fill(); }
    x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); x.strokeStyle = color; x.lineWidth = 2.5; x.stroke();
  }
  function grid(x, px, py, w, h) { x.strokeStyle = '#131822'; x.lineWidth = 1; for (let i = 0; i <= 8; i++) { x.beginPath(); x.moveTo(px, py + i * h / 8); x.lineTo(px + w, py + i * h / 8); x.stroke(); } for (let i = 0; i <= 12; i++) { x.beginPath(); x.moveTo(px + i * w / 12, py); x.lineTo(px + i * w / 12, py + h); x.stroke(); } }
  function orderbook(x, px, py, w, rows, seed) {
    const r = E.rng(seed);
    uiText(x, 'Order Book', px + 16, py + 24, 16, '#fff', 600); uiText(x, 'Trades', px + 130, py + 24, 16, '#7d8594', 500);
    for (let i = 0; i < rows; i++) {
      const y = py + 60 + i * 30, depth = r();
      x.fillStyle = i < rows / 2 ? 'rgba(220,60,70,0.22)' : 'rgba(40,190,120,0.2)'; x.fillRect(px + w * (1 - depth), y - 12, w * depth - 8, 24);
      uiText(x, (1.62 - i * 0.012).toFixed(4), px + 16, y, 14, i < rows / 2 ? '#ff6b76' : '#34d399', 500, 'left', MONO);
      uiText(x, String(Math.round(r() * 20)), px + w - 20, y, 14, '#c6ccd8', 500, 'right', MONO);
    }
  }
  S.dashboard = () => {
    const W = 1600, H = 1000, [c, x] = mk(W, H);
    x.fillStyle = '#050608'; x.fillRect(0, 0, W, H); header(x, W, (V.nav || [])[2] || 'Vault');
    x.beginPath(); x.arc(52, 118, 20, 0, 7); x.fillStyle = V.brand.color; x.fill();
    uiText(x, 'Vault', 86, 110, 28, '#fff', 600); uiText(x, 'Automated liquidity strategy · withdraw any time', 86, 140, 15, '#7d8594', 400);
    [['APY', '11.45%'], ['TVL', '$2.9M'], ['Earnings', '+$804.5K'], ['Depositors', '1,204']].forEach(([k, v], i) => {
      panel(x, 32 + i * 272, 176, 256, 96); uiText(x, k, 52 + i * 272, 204, 14, '#7d8594', 500); uiText(x, v, 52 + i * 272, 242, 28, i === 2 ? '#34d399' : '#fff', 600);
    });
    panel(x, 32, 292, 1080, 680); uiText(x, 'Vault Performance', 56, 326, 18, '#fff', 600); uiText(x, '$1.5621', 56, 380, 34, '#fff', 600);
    grid(x, 56, 420, 1030, 520); line(x, 56, 440, 1030, 480, [0, 30, 55, 70, 80, 86, 90, 92, 93, 94, 94.5, 95, 95.4, 95.6, 96], '#34d399', 'rgba(52,211,153,0.35)');
    panel(x, 1130, 292, 440, 680); uiText(x, 'Deposit', 1154, 326, 18, '#fff', 600); uiText(x, 'Withdraw', 1250, 326, 18, '#7d8594', 500);
    rr(x, 1154, 360, 392, 56, 10); x.fillStyle = '#131722'; x.fill(); uiText(x, '0.00', 1174, 388, 22, '#fff', 500, 'left', MONO);
    rr(x, 1154, 880, 392, 60, 10); x.fillStyle = V.brand.color; x.fill(); uiText(x, 'Deposit', 1350, 910, 18, '#fff', 600, 'center');
    return c;
  };
  S.trade = () => {
    const W = 1600, H = 1000, [c, x] = mk(W, H);
    x.fillStyle = '#050608'; x.fillRect(0, 0, W, H); header(x, W, (V.nav || [])[0] || 'Spot');
    uiText(x, 'SUI/USDC', 60, 100, 18, '#fff', 600); uiText(x, '3.4012', 180, 100, 18, '#34d399', 600, 'left', MONO); uiText(x, '24h Change  +2.1%    24h Volume  $18.2M', 300, 100, 14, '#7d8594', 500);
    x.fillStyle = '#0a0c11'; x.fillRect(0, 130, 48, 870);
    for (let i = 0; i < 12; i++) { rr(x, 14, 150 + i * 48, 20, 20, 4); x.strokeStyle = '#3a4150'; x.lineWidth = 2; x.stroke(); }
    grid(x, 60, 140, 880, 700); candles(x, 60, 170, 880, 640, 80, 'trade', V.brand.color, '#e6ebf5');
    panel(x, 956, 130, 300, 850); orderbook(x, 956, 140, 300, 24, 'ob');
    panel(x, 1272, 130, 312, 850); uiText(x, 'Market', 1296, 164, 16, '#fff', 600); uiText(x, 'Limit', 1380, 164, 16, '#7d8594', 500);
    rr(x, 1296, 196, 132, 40, 8); x.fillStyle = 'rgba(52,211,153,0.2)'; x.fill(); uiText(x, 'Buy', 1362, 216, 15, '#34d399', 600, 'center');
    rr(x, 1440, 196, 120, 40, 8); x.fillStyle = '#131722'; x.fill(); uiText(x, 'Sell', 1500, 216, 15, '#9aa3b2', 600, 'center');
    [260, 340, 420].forEach((y) => { rr(x, 1296, y, 264, 52, 8); x.fillStyle = '#131722'; x.fill(); });
    rr(x, 1296, 900, 264, 56, 10); x.fillStyle = V.brand.color; x.fill(); uiText(x, 'Buy SUI', 1428, 928, 17, '#fff', 600, 'center');
    panel(x, 60, 856, 880, 124); uiText(x, 'Positions   Limit Orders   History', 80, 884, 14, '#9aa3b2', 500);
    return c;
  };
  S.range = () => {
    const W = 1600, H = 1000, [c, x] = mk(W, H);
    x.fillStyle = '#050608'; x.fillRect(0, 0, W, H); header(x, W, (V.nav || [])[1] || 'Predict');
    ['BTC 1D · 11:07', 'TODAY 11:30', 'TODAY 12:00'].forEach((s, i) => { rr(x, 40 + i * 190, 84, 176, 36, 8); x.strokeStyle = i ? '#232a36' : V.brand.color; x.lineWidth = 2; x.stroke(); uiText(x, s, 128 + i * 190, 102, 14, '#cfd6e4', 500, 'center'); });
    grid(x, 40, 140, 900, 700);
    line(x, 40, 220, 900, 520, series('r1', 120, 50, 3), V.brand.color, 'rgba(34,103,242,0.25)');
    line(x, 40, 260, 900, 480, series('r2', 120, 50, 2.4), '#f5a524');
    panel(x, 960, 130, 300, 850); uiText(x, 'Set a Price Range', 984, 164, 16, '#fff', 600);
    ['$79,600', '$79,595', '$79,590', '$79,585', '$79,580'].forEach((p, i) => {
      rr(x, 990, 210 + i * 64, 240, 52, 8); x.fillStyle = i >= 1 && i <= 3 ? 'rgba(34,103,242,0.28)' : '#10141c'; x.fill();
      if (i >= 1 && i <= 3) { x.strokeStyle = V.brand.color; x.lineWidth = 2; x.stroke(); }
      uiText(x, p, 1110, 236 + i * 64, 20, '#fff', 600, 'center', MONO);
    });
    panel(x, 1276, 130, 308, 850); uiText(x, 'Lower Bound', 1300, 170, 14, '#7d8594', 500); uiText(x, 'Upper Bound', 1440, 170, 14, '#7d8594', 500);
    rr(x, 1300, 188, 124, 44, 8); rr(x, 1440, 188, 124, 44, 8); x.fillStyle = '#131722'; x.fill();
    uiText(x, 'Purchase', 1300, 280, 16, '#fff', 600); rr(x, 1300, 300, 264, 52, 8); x.fillStyle = '#131722'; x.fill();
    rr(x, 1300, 900, 264, 56, 10); x.fillStyle = V.brand.color; x.fill(); uiText(x, 'Buy Range', 1432, 928, 17, '#fff', 600, 'center');
    return c;
  };
  S.minute = () => {
    const W = 1600, H = 1000, [c, x] = mk(W, H);
    x.fillStyle = '#050608'; x.fillRect(0, 0, W, H); header(x, W, (V.nav || [])[1] || 'Predict');
    x.fillStyle = 'rgba(40,190,120,0.06)'; x.fillRect(0, 64, W, 120);
    grid(x, 0, 200, W, 520);
    line(x, 0, 300, W * 0.62, 380, series('m1', 90, 50, 2.2), V.brand.color, 'rgba(34,103,242,0.22)');
    x.strokeStyle = '#3a4150'; x.setLineDash([6, 6]); x.beginPath(); x.moveTo(W * 0.62, 200); x.lineTo(W * 0.62, 720); x.stroke(); x.setLineDash([]);
    panel(x, W / 2 - 280, 740, 560, 220); uiText(x, 'BTC · 1 minute round', W / 2 - 256, 776, 15, '#9aa3b2', 500); uiText(x, '0:12', W / 2 + 256, 776, 18, '#fff', 600, 'right', MONO);
    rr(x, W / 2 - 256, 806, 250, 80, 10); x.fillStyle = 'rgba(52,211,153,0.2)'; x.fill(); uiText(x, '↑ Up', W / 2 - 131, 846, 22, '#34d399', 600, 'center');
    rr(x, W / 2 + 6, 806, 250, 80, 10); x.fillStyle = 'rgba(255,107,118,0.18)'; x.fill(); uiText(x, '↓ Down', W / 2 + 131, 846, 22, '#ff6b76', 600, 'center');
    return c;
  };
  S.mobile = () => {
    const W = 780, H = 1600, [c, x] = mk(W, H);
    x.fillStyle = '#05070c'; x.fillRect(0, 0, W, H); const r = E.rng('mob');
    for (let i = 0; i < 40; i++) { x.fillStyle = V.brand.color; x.globalAlpha = 0.5 + r() * 0.5; x.fillRect(40, 120 + i * 34, 60 + r() * 500, 20); }
    return c;
  };
  E.standInScreen = function (name) {
    const f = S[name] || S.dashboard;
    return f();
  };
  E.STANDIN_SCREENS = Object.keys(S);
})();
