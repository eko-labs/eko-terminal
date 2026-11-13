/* Act implementations. Each act: needs(cfg) → assets to preload,
 * build(cfg, root, ctx) → { update(localT, dur, globalT), busy?() }.
 * See references/config-reference.md in the skill for every option.
 */
(function () {
  const V = E.V, W = E.W, H = E.H, { clamp, lerp, prog, ease } = E;
  const theme = (cfg) => (cfg.theme === 'brand'
    ? { bg: V.brand.color, fg: V.brand.onColor }
    : { bg: V.brand.paper, fg: V.brand.ink });
  const bump = (t, d) => (t < 0 || t > d ? 0 : Math.sin((t / d) * Math.PI));

  /* ---------- shared: the ordered row between two rules ---------- */
  const DEFAULT_CHAOS = ['crowd', 'bell', 'fist', 'pile', 'watch', 'cash', 'ribbon', 'palm'];
  const DEFAULT_ROW = ['seal', 'envelope', 'quill', 'card', 'gridcard', 'wheat', 'coin', 'thumb'];
  const ROW_SCALE = { seal: 0.46, envelope: 0.5, quill: 0.86, card: 0.82, gridcard: 0.68, wheat: 0.8, coin: 0.7, thumb: 0.6, token: 0.3, watch: 0.8, bell: 0.8 };
  const RULES = { top: 0.385, bottom: 0.8, x0: 0.065, x1: 0.935 };
  const rowY = () => ((RULES.top + RULES.bottom) / 2) * H;

  // Row entries are prop names, or {name, scale} to size one relative to the row height.
  const rowName = (n) => (typeof n === 'string' ? n : n.name);
  function buildRow(parent, names, rowH) {
    const items = names.map((n) => E.sprite(parent, rowName(n), rowH * ((typeof n === 'object' && n.scale) || ROW_SCALE[rowName(n)] || 0.7)));
    const span = (RULES.x1 - RULES.x0) * W, minGap = W * 0.018;
    const total = items.reduce((s, i) => s + i.w, 0);
    const k = Math.min(1, (span - minGap * (items.length - 1)) / total);
    if (k < 1) items.forEach((i) => { i.w *= k; i.h *= k; i.e.style.width = i.w + 'px'; i.e.style.height = i.h + 'px'; });
    const tot2 = items.reduce((s, i) => s + i.w, 0), gap = (span - tot2) / Math.max(1, items.length - 1);
    let x = RULES.x0 * W;
    items.forEach((i) => { i.cx = x + i.w / 2; x += i.w + gap; });
    return items;
  }
  // brand.ruleStyle: 'line' (default) or 'meander' (a Greek-key band in brand.ruleColor).
  const meanderBg = (color) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'><path d='M0 2.5H28M0 25.5H28M5 25.5V8H21V20H11V14H16' fill='none' stroke='${color}' stroke-width='2.6'/></svg>`)}")`;
  function makeRules(parent, color) {
    const meander = V.brand.ruleStyle === 'meander';
    const h = meander ? Math.round(H * 0.02) : Math.max(2, Math.round(H / 400));
    return [RULES.top, RULES.bottom].map((y) => E.el('div', Object.assign({}, E.abs, {
      width: (RULES.x1 - RULES.x0) * W + 'px', height: h + 'px',
      background: meander ? `${meanderBg(V.brand.ruleColor || color)} repeat-x 0 0 / auto 100%` : color,
      transform: `translate(${RULES.x0 * W}px, ${y * H - (meander ? h / 2 : 0)}px) scaleX(0)`, opacity: meander ? 1 : 0.85,
    }), parent));
  }
  function setRule(r, y, sx) { const h = r.offsetHeight > 4 ? r.offsetHeight / 2 : 0; r.style.transform = `translate(${RULES.x0 * W}px, ${y * H - h}px) scaleX(${sx})`; }

  /* ---------- shared: tilted UI "plane" ---------- */
  const FLAT = { rx: 0, ry: 0, rz: 0, s: 1, x: 0, y: 0 };
  const TILT = { rx: 24, ry: -16, rz: 5, s: 0.9, x: 0.02, y: 0.05 };
  const lerpPose = (a, b, e) => { const o = {}; for (const k of Object.keys(FLAT)) o[k] = lerp(a[k] ?? FLAT[k], b[k] ?? FLAT[k], e); return o; };
  function makePlane(parent, screenName) {
    const a = E.screen(screenName);
    const k = Math.max(W / a.w, H / a.h);
    const pw = a.w * k, ph = a.h * k;
    const plane = E.el('div', Object.assign({}, E.abs, {
      width: pw + 'px', height: ph + 'px', borderRadius: '14px', overflow: 'hidden',
      boxShadow: '0 50px 140px rgba(0,0,0,0.35)', willChange: 'transform', transformStyle: 'flat',
    }), parent);
    const img = E.el('img', { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }, plane);
    img.src = a.url;
    return { plane, img, pw, ph, a };
  }
  function setPose(p, pose, o = 1) {
    p.plane.style.transform = `translate(${W / 2 + pose.x * W}px,${H / 2 + pose.y * H}px) translate(-50%,-50%) perspective(2600px) rotateX(${pose.rx}deg) rotateY(${pose.ry}deg) rotateZ(${pose.rz}deg) scale(${pose.s})`;
    p.plane.style.opacity = o;
  }
  // When an `order` act zooms into the same screen, start at its framing so the cut is seamless.
  function handoffScale(ctx, cfg) {
    const h = ctx && ctx.prev && ctx.prev.handoff && ctx.prev.handoff();
    return h && h.screen === (cfg.screen || 'dashboard') ? h.s : 1;
  }
  const CURSOR_SVG = '<svg viewBox="0 0 32 32" width="100%" height="100%"><path d="M11 3.5c1.1 0 2 .9 2 2V14l.9-.2c.3-1 1.2-1.6 2.2-1.6 1 0 1.8.6 2.1 1.4.4-.3.9-.5 1.5-.5 1.1 0 2 .7 2.2 1.7.4-.2.8-.3 1.2-.3 1.3 0 2.3 1 2.3 2.3v5.7c0 4.2-3 7.5-7.4 7.5h-2.2c-2.3 0-4-1-5.3-2.8l-4.6-6.4c-.6-.9-.4-2.1.5-2.7.8-.6 2-.4 2.6.4L9 19V5.5c0-1.1.9-2 2-2z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  function makeCursor(parent, size) {
    const c = E.el('div', Object.assign({}, E.abs, { width: size + 'px', height: size + 'px', zIndex: 20, filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.35))' }), parent, CURSOR_SVG);
    return { e: c, size };
  }
  function setCursor(c, x, y, scale, o = 1) {
    // Hotspot is the fingertip at (11, 3.5) of the 32-unit viewBox.
    c.e.style.transform = `translate(${x - c.size * 11 / 32}px,${y - c.size * 3.5 / 32}px) scale(${scale})`;
    c.e.style.transformOrigin = `${c.size * 11 / 32}px ${c.size * 3.5 / 32}px`;
    c.e.style.opacity = o;
  }
  // Keyframed cursor path: [{t, x, y, click}] with x/y as fractions of (w, h).
  function cursorAt(keys, t, w, h) {
    if (!keys || !keys.length) return null;
    let i = 0;
    while (i < keys.length - 1 && t >= keys[i + 1].t) i++;
    const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
    let x = a.x, y = a.y;
    if (b !== a && t > a.t) { const travel = Math.min(0.55, (b.t - a.t) * 0.8); const e = ease.inOutCubic(prog(t, b.t - travel, travel)); x = lerp(a.x, b.x, e); y = lerp(a.y, b.y, e); }
    let squish = 0; keys.forEach((k) => { if (k.click) squish = Math.max(squish, bump(t - k.t, 0.18)); });
    const o = clamp((t - keys[0].t + 0.15) / 0.15);
    return { x: x * w, y: y * h, s: 1 - 0.18 * squish, o };
  }

  /* ================= chaos ================= */
  const CHAOS_SLOTS = [
    { x: 0.13, y: 0.78, h: 0.7, r: 3, from: [-0.35, 0.45] },
    { x: 0.68, y: 0.13, h: 0.37, r: -14, from: [0.12, -0.6] },
    { x: 0.95, y: 0.42, h: 0.5, r: 8, from: [0.45, 0.2] },
    { x: 0.84, y: 0.87, h: 0.4, r: -4, from: [0.4, 0.5] },
    { x: 0.31, y: 0.84, h: 0.34, r: -6, from: [0.0, 0.6] },
    { x: 0.42, y: 0.16, h: 0.28, r: 10, from: [-0.1, -0.55] },
    { x: 0.08, y: 0.12, h: 0.22, r: -20, from: [-0.4, -0.4] },
    { x: 0.57, y: 0.86, h: 0.28, r: 6, from: [0.1, 0.6] },
    { x: 0.23, y: 0.3, h: 0.22, r: 12, from: [-0.3, -0.3] },
    { x: 0.8, y: 0.55, h: 0.22, r: -10, from: [0.4, 0.1] },
  ];
  E.registerAct('chaos', {
    needs: (cfg) => ({ props: [...(cfg.props || DEFAULT_CHAOS).map((p) => (typeof p === 'string' ? p : p.name)), ...(cfg.resolve ? (cfg.resolve.row || DEFAULT_ROW).map(rowName) : [])] }),
    build(cfg, root) {
      const th = theme(cfg);
      root.style.background = th.bg;
      const slots = cfg.slots || CHAOS_SLOTS;
      // A prop is a name (placed in slot i) or {name, slot: index | {x, y, h, r, from}}.
      const pieces = (cfg.props || DEFAULT_CHAOS).map((p, i) => {
        const n = typeof p === 'string' ? p : p.name;
        const sl = typeof p === 'object' && p.slot != null ? p.slot : i;
        const s = typeof sl === 'object' ? Object.assign({ r: 0, from: [0, 0.6] }, sl) : slots[sl % slots.length];
        return { sp: E.sprite(root, n, s.h * H), s, i };
      });
      const textY = cfg.textY != null ? cfg.textY : 0.5;
      const tl = E.textLine(root, cfg.headline || '', { fontSize: (cfg.fontSize || 0.046) * H + 'px', color: th.fg, zIndex: 5 });
      const g = cfg.glitchWord ? E.glitchWord(tl.box, cfg.glitchWord) : null;
      const words = g ? [...tl.words, g.box] : tl.words;
      const t0 = cfg.textStart != null ? cfg.textStart : 0.85, gap = cfg.wordGap || 0.26;
      const times = words.map((_, i) => t0 + i * gap + (g && i === words.length - 1 ? gap * 0.4 : 0));
      const glitchUntil = cfg.resolve ? cfg.resolve.at : (cfg.glitchUntil != null ? cfg.glitchUntil : 1e9);

      let row = null, rules = null, line = null;
      if (cfg.resolve) {
        const rw = E.el('div', Object.assign({}, E.abs, { width: W + 'px', height: H + 'px' }), root);
        row = buildRow(rw, cfg.resolve.row || DEFAULT_ROW, (RULES.bottom - RULES.top) * H * 0.72);
        rules = makeRules(root, th.fg);
        line = E.el('div', Object.assign({}, E.abs, { width: (RULES.x1 - RULES.x0) * W + 'px', height: '3px', background: th.fg }), root);
      }
      return {
        update(lt, dur) {
          const R = cfg.resolve;
          const exitAt = R ? R.at : dur - 0.32;
          pieces.forEach(({ sp, s, i }) => {
            const p = prog(lt, (cfg.enterStart || 0) + i * 0.075, 0.6);
            const e = ease.outBack(p, 1.25);
            let x = lerp(s.x * W + s.from[0] * W, s.x * W, e), y = lerp(s.y * H + s.from[1] * H, s.y * H, e);
            let r = s.r + (1 - e) * s.from[0] * 50, sc = 1;
            x += Math.sin(lt * 1.9 + i * 1.7) * H * 0.006; y += Math.cos(lt * 2.3 + i) * H * 0.008; r += Math.sin(lt * 1.3 + i * 2.1) * 1.6;
            const pe = ease.inCubic(prog(lt, exitAt + i * 0.015, 0.3));
            if (cfg.exit !== false || R) { const dx = s.x - 0.5, dy = s.y - 0.5, n = Math.hypot(dx, dy) || 1; x += dx / n * pe * W * 0.45; y += dy / n * pe * H * 0.45; sc *= 1 - 0.3 * pe; }
            E.xf(sp.e, { x, y, r, s: sc, o: p > 0 ? 1 - pe : 0 });
          });
          E.revealWords(words, lt, times);
          words.forEach((w, i) => { w.style.display = lt >= times[i] ? 'inline-block' : 'none'; });
          const fade = cfg.exit !== false && !R ? 1 - prog(lt, dur - 0.25, 0.2) : 1;
          E.xf(tl.box, { x: W / 2, y: textY * H, o: fade });
          if (g) E.updateGlitch(g, lt, lt < glitchUntil ? 1 : 0, 3);
          if (R) {
            const lp = ease.outCubic(prog(lt, R.at, 0.3));
            const sp = ease.inOutCubic(prog(lt, R.at + 0.28, 0.35));
            line.style.transform = `translate(${RULES.x0 * W}px, ${rowY()}px) scaleX(${lp})`;
            line.style.opacity = sp > 0 ? 0 : 1;
            rules.forEach((rl, j) => setRule(rl, lerp(rowY() / H, j ? RULES.bottom : RULES.top, sp), sp > 0 ? 1 : 0));
            row.forEach((it, j) => {
              const p = prog(lt, R.at + 0.4 + j * 0.035, 0.35), e = ease.outBack(p, 1.4);
              E.xf(it.e, { x: it.cx, y: rowY() + Math.sin(lt * 2 + j) * 2, s: 0.6 + 0.4 * e, o: clamp(p * 3) });
            });
          }
        },
      };
    },
  });

  /* ================= triptych ================= */
  const COLS = [{ lx: 0.07, cx: 0.2 }, { lx: 0.405, cx: 0.5 }, { lx: 0.735, cx: 0.83 }];
  const SCATTER = [[-0.06, -0.15, 0.13], [0.04, -0.05, 0.17], [-0.09, 0.05, 0.15], [0.0, 0.14, 0.12], [0.08, 0.1, 0.12], [-0.12, -0.02, 0.1], [0.1, -0.16, 0.1]];
  // Resolve a column's props with the same defaults build() uses, so needs() preloads them.
  const colProps = (c) => {
    if (c.visual === 'split') return { main: [c.prop || 'coin'] };
    if (c.visual === 'hands') return { main: c.props && c.props.length ? c.props : ['hand'], center: c.center };
    return { main: c.props && c.props.length ? c.props : [c.prop || 'scrap'] };
  };
  E.registerAct('triptych', {
    needs: (cfg) => ({ props: (cfg.columns || []).flatMap((c) => { const p = colProps(c); return [...p.main, ...(p.center ? [p.center] : [])]; }) }),
    build(cfg, root) {
      const th = theme(cfg);
      root.style.background = th.bg;
      const stagger = cfg.colStagger || 1.5;
      const cols = (cfg.columns || []).slice(0, 3).map((c, ci) => {
        const geo = COLS[ci], t0 = (cfg.start || 0.1) + ci * stagger;
        const label = E.el('div', Object.assign({}, E.abs, {
          width: 0.22 * W + 'px', fontFamily: V.brand.font, fontWeight: V.brand.textWeight, fontSize: (cfg.labelSize || 0.034) * H + 'px',
          lineHeight: 1.18, color: th.fg, letterSpacing: '-0.005em', transform: `translate(${geo.lx * W}px, ${(cfg.labelY || 0.8) * H}px)`,
        }), root);
        const words = E.fill(c.label).split(/\s+/).map((w) => { const s = E.el('span', { display: 'inline-block', marginRight: '0.26em' }, label); s.textContent = w; return s; });
        const wgap = Math.min(0.45, 1.3 / Math.max(1, words.length - 1));
        const times = words.map((_, i) => t0 + i * wgap);
        const vy = (cfg.visualY || 0.42) * H, vx = geo.cx * W;
        const col = { c, ci, t0, words, times, vx, vy, sprites: [] };
        if (c.visual === 'split') {
          const hh = (c.size || 0.3) * H;
          col.quads = [[0, 50, 50, 0], [0, 0, 50, 50], [50, 50, 0, 0], [50, 0, 0, 50]].map(([t, r, b, l]) => {
            const s = E.sprite(root, colProps(c).main[0], hh);
            s.e.style.clipPath = `inset(${t}% ${r}% ${b}% ${l}%)`;
            col.sprites.push(s);
            return s;
          });
        } else if (c.visual === 'hands') {
          const n = c.count || 6;
          if (c.center) col.center = E.sprite(root, c.center, (c.centerSize || 0.035) * H);
          const hp = colProps(c).main;
          col.hands = Array.from({ length: n }, (_, i) => {
            const s = E.sprite(root, hp[i % hp.length], (c.size || 0.2) * H);
            const ang = (-90 + 25 + i * (360 / n) + (E.r2(i, 4) - 0.5) * 30) * Math.PI / 180;
            col.sprites.push(s);
            return { s, ang, at: t0 + (c.stagger || 0.24) * i, flip: i % 2 ? -1 : 1 };
          });
          if (col.center) col.sprites.push(col.center);
        } else {
          const list = colProps(c).main;
          col.items = list.map((n, i) => {
            const L = c.visual === 'single' ? [0, 0, c.size || 0.3] : SCATTER[i % SCATTER.length];
            const s = E.sprite(root, n, L[2] * H * (c.scale || 1.25));
            col.sprites.push(s);
            return { s, L, i, r0: (E.r2(i, ci, 11) - 0.5) * 30 };
          });
        }
        return col;
      });
      let rects = [];
      return {
        busy: () => rects,
        update(lt) {
          rects = [];
          const track = (s, x, y, sc = 1) => { rects.push([x - s.w * sc / 2, y - s.h * sc / 2, x + s.w * sc / 2, y + s.h * sc / 2]); };
          cols.forEach((col) => {
            const { c, t0, vx, vy } = col;
            col.words.forEach((w, i) => { const p = ease.outCubic(prog(lt, col.times[i], 0.14)); w.style.opacity = p; w.style.transform = `translateY(${(1 - p) * 0.2}em)`; });
            if (col.quads) {
              const p = prog(lt, t0, 0.35), e = ease.outBack(p, 1.5), sp = ease.inOutCubic(prog(lt, t0 + (c.splitAt || 0.55), 0.45));
              const d = (c.gap || 0.03) * H;
              col.quads.forEach((s, i) => {
                const sx = i === 0 || i === 1 ? -1 : 1, sy = i === 0 || i === 2 ? -1 : 1;
                const wob = Math.sin(lt * 2.2 + i * 1.3) * 0.004 * H * sp;
                const x = vx + sx * d * sp + wob, y = vy + sy * d * sp - wob;
                E.xf(s.e, { x, y, s: 0.4 + 0.6 * e, r: sp * sx * sy * 5, o: p > 0 ? 1 : 0 });
                if (p > 0) track(s, x, y);
              });
            } else if (col.hands) {
              if (col.center) { const p = prog(lt, t0, 0.2); E.xf(col.center.e, { x: vx, y: vy, s: ease.outBack(p), o: p > 0 ? 1 : 0 }); }
              const R = (c.reach || 0.15) * H;
              col.hands.forEach(({ s, ang, at, flip }, i) => {
                const p = prog(lt, at, 0.5), e = ease.outCubic(p);
                const rr = lerp(R * 2.2, R, e) + Math.sin(lt * 3 + i * 1.7) * 0.012 * H;
                const x = vx + Math.cos(ang) * rr, y = vy + Math.sin(ang) * rr;
                const rot = ang * 180 / Math.PI - 90 + Math.sin(lt * 2 + i) * 3;
                E.xf(s.e, { x, y, r: rot, sx: flip, sy: 1, o: p > 0 ? clamp(p * 4) : 0 });
                if (p > 0) track(s, x, y, 0.6);
              });
            } else {
              col.items.forEach(({ s, L, i, r0 }) => {
                const p = prog(lt, t0 + i * 0.12, 0.4), e = ease.outBack(p, 1.6);
                const amp = c.visual === 'single' ? 0.006 : 0.028;
                const x = vx + L[0] * W + Math.sin(lt * 0.9 + i * 2.1) * amp * W, y = vy + L[1] * H + Math.cos(lt * 0.75 + i * 1.3) * amp * H;
                E.xf(s.e, { x, y, s: 0.5 + 0.5 * e, r: r0 + Math.sin(lt * 0.8 + i) * 7, o: p > 0 ? 1 : 0 });
                if (p > 0) track(s, x, y);
              });
            }
          });
        },
      };
    },
  });

  /* ================= dissolve: dot grid + ASCII streaks eat the frame ================= */
  E.registerAct('dissolve', {
    build(cfg, root, ctx) {
      const cv = E.el('canvas', Object.assign({}, E.abs), root);
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      const cell = cfg.cell || Math.round(H / 42);
      const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
      const order = new Float32Array(cols * rows);
      let mn = 9, mx = -9;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const v = 0.7 * E.noise2(c * 0.09, r * 0.09, 3) + 0.3 * E.r2(c, r, 9) + (cfg.direction === 'ltr' ? c / cols * 0.6 : 0);
        order[r * cols + c] = v; mn = Math.min(mn, v); mx = Math.max(mx, v);
      }
      for (let i = 0; i < order.length; i++) order[i] = (order[i] - mn) / (mx - mn);
      const rnd = E.rng('streaks');
      const DIRS = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];
      const glyphs = cfg.glyphs || { diag: '/', h: 'x?', v: '01' };
      const streaks = Array.from({ length: cfg.streaks || 54 }, () => {
        let c = Math.floor(rnd() * cols), r = Math.floor(rnd() * rows), d = Math.floor(rnd() * 8);
        const len = 6 + Math.floor(rnd() * 18), cells = [];
        for (let i = 0; i < len; i++) {
          const [dx, dy] = DIRS[d];
          const set = dx && dy ? glyphs.diag : dy ? glyphs.v : glyphs.h;
          const ch = (dx * dy > 0 && set === glyphs.diag) ? '\\' : set[Math.floor(rnd() * set.length)];
          cells.push([c, r, dx * dy < 0 ? '/' : ch]);
          c += dx; r += dy;
          if (rnd() < 0.18) d = (d + (rnd() < 0.5 ? 1 : 7)) % 8;
        }
        return { cells, birth: rnd() * 0.55, len };
      });
      const paper = V.brand.paper, blue = V.brand.color, ink = V.brand.ink;
      return {
        update(lt, dur) {
          const p = lt / dur;
          g.clearRect(0, 0, W, H);
          const eat = clamp((p - 0.1) / 0.55) * 1.1;
          const busy = ctx.prev && ctx.prev.busy ? ctx.prev.busy() : [];
          const inBusy = (x, y) => busy.some((b) => x > b[0] && x < b[2] && y > b[1] && y < b[3]);
          for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            const o = order[r * cols + c], x = c * cell, y = r * cell;
            if (o < eat) { g.fillStyle = paper; g.fillRect(x, y, cell, cell); }
            else if (o < eat + 0.09 && eat > 0 && inBusy(x + cell / 2, y + cell / 2)) { g.fillStyle = blue; g.fillRect(x + 1, y + 1, cell - 2, cell - 2); }
          }
          const da = clamp(p / 0.15) * 0.45;
          g.fillStyle = ink; g.globalAlpha = da;
          const dr = Math.max(1.2, cell * 0.06);
          for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { g.beginPath(); g.arc(c * cell + cell / 2, r * cell + cell / 2, dr, 0, 6.3); g.fill(); }
          g.globalAlpha = 1;
          g.font = `600 ${Math.round(cell * 0.78)}px 'Courier New', Menlo, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
          const fadeAll = 1 - clamp((p - 0.82) / 0.18);
          streaks.forEach((s) => {
            const l = (p - s.birth) / 0.3;
            if (l <= 0) return;
            const head = Math.floor(l * s.len), tail = l > 1 ? Math.floor((l - 1) / 0.8 * s.len) : 0;
            for (let i = tail; i <= Math.min(head, s.len - 1); i++) {
              const [c, r, ch] = s.cells[i];
              g.globalAlpha = 0.9 * fadeAll; g.fillStyle = ink;
              g.fillText(ch, c * cell + cell / 2, r * cell + cell / 2);
            }
          });
          g.globalAlpha = 1;
        },
      };
    },
  });

  /* ================= order: brand color, rules, conveyor → candles → CRT → zoom ================= */
  E.registerAct('order', {
    needs: (cfg) => ({
      props: [...(cfg.row || DEFAULT_ROW).map(rowName), ...(cfg.monitor === false ? [] : ['monitor']), ...(cfg.phone === false || cfg.monitor === false ? [] : ['phone']), ...(cfg.monitorIdle ? [cfg.monitorIdle] : [])],
      screens: cfg.monitor === false ? [] : [cfg.screen || 'dashboard'],
    }),
    build(cfg, root) {
      const T = Object.assign({ band: 0, bandDur: 0.45, rules: 0.12, title: 0.22, sub: 0.5, subGap: 0.2, conveyor: 0.8, conveyorDur: 1.0, monitorIn: 1.9, monitorDur: 0.4, phoneIn: 2.3, switchAt: 2.62, titleOut: 3.0, zoomAt: 3.2, zoomDur: 0.85 }, cfg.timing || {});
      const fg = V.brand.onColor;
      const band = E.el('div', Object.assign({}, E.abs, { width: W + 'px', height: H + 'px', background: V.brand.color }), root);
      const gridCell = Math.round(H / 24);
      const gridEl = E.el('div', Object.assign({}, E.abs, {
        width: W + 'px', height: H + 'px',
        backgroundImage: `linear-gradient(rgba(255,255,255,.38) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.38) 1px, transparent 1px)`,
        backgroundSize: `${gridCell}px ${gridCell}px`, backgroundPosition: `${W / 2}px ${H / 2}px`,
      }), band);
      const title = E.textLine(band, cfg.title || '{brand}', { fontSize: (cfg.titleSize || 0.085) * H + 'px', fontWeight: V.brand.titleWeight, color: fg, letterSpacing: '-0.025em' });
      const sub = E.textLine(band, cfg.subtitle || '', { fontSize: (cfg.subtitleSize || 0.042) * H + 'px', fontWeight: V.brand.titleWeight, color: fg });
      const rules = makeRules(band, fg);
      const conveyor = E.el('div', Object.assign({}, E.abs, { width: W + 'px', height: H + 'px' }), band);
      const rowH = (RULES.bottom - RULES.top) * H * 0.72;
      const row = buildRow(conveyor, cfg.row || DEFAULT_ROW, rowH);
      // Far enough that the whole row leaves the frame once the chart has arrived.
      const span = (RULES.x1 - RULES.x0) * W, shiftD = W * (1 - RULES.x0) + Math.max(...row.map((i) => i.w)) + W * 0.02;

      // Candlestick chart that pushes the row off to the right.
      const useChart = cfg.chart !== false;
      const chart = E.el('div', Object.assign({}, E.abs, { width: span + 'px', height: 0.3 * H + 'px' }), band);
      if (useChart) {
        const n = cfg.candles || 22, rnd = E.rng('order-candles');
        let v = 0; const bars = [];
        for (let i = 0; i < n; i++) { const o = v, c = v + (rnd() - 0.42) * 1.6; bars.push([o, c, Math.max(o, c) + rnd() * 0.7, Math.min(o, c) - rnd() * 0.7]); v = c; }
        const lo = Math.min(...bars.map((b) => b[3])), hi = Math.max(...bars.map((b) => b[2]));
        const Y = (x) => (1 - (x - lo) / (hi - lo)) * 0.3 * H, bw = span / n;
        bars.forEach(([o, c, h, l], i) => {
          const col = c >= o ? '#ffffff' : '#c9d6f2';
          E.el('div', Object.assign({}, E.abs, { left: i * bw + bw / 2 - 1 + 'px', top: Y(h) + 'px', width: '2px', height: Y(l) - Y(h) + 'px', background: col }), chart);
          E.el('div', Object.assign({}, E.abs, { left: i * bw + bw * 0.28 + 'px', top: Math.min(Y(o), Y(c)) + 'px', width: bw * 0.44 + 'px', height: Math.max(3, Math.abs(Y(o) - Y(c))) + 'px', background: col }), chart);
        });
      }
      chart.style.transformOrigin = '0 0';

      // CRT monitor with a screen layer, and an optional phone.
      const useMonitor = cfg.monitor !== false;
      let mon = null, phone = null;
      if (useMonitor) {
        const mh = (cfg.monitorSize || 0.5) * H;
        const ma = E.prop('monitor');
        const mw = mh * ma.w / ma.h;
        const rect = cfg.monitorScreen || ((V.props || {}).monitor && V.props.monitor.screenRect) || E.MONITOR_SCREEN;
        const group = E.el('div', Object.assign({}, E.abs, { width: mw + 'px', height: mh + 'px', zIndex: 3 }), band);
        const img = E.el('img', { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }, group); img.src = ma.url;
        const scr = E.el('div', { position: 'absolute', left: rect[0] * 100 + '%', top: rect[1] * 100 + '%', width: rect[2] * 100 + '%', height: rect[3] * 100 + '%', overflow: 'hidden', borderRadius: '4%/5%', background: V.brand.color }, group);
        const sa = E.screen(cfg.screen || 'dashboard');
        const ui = E.el('img', { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: '50% 50%' }, scr); ui.src = sa.url;
        const flash = E.el('div', { position: 'absolute', left: 0, right: 0, top: '50%', height: '3px', background: '#fff', opacity: 0 }, scr);
        // Without a chart, the CRT shows an idle prop (e.g. the logo) until it switches to the product.
        let idle = null;
        if (cfg.chart === false && cfg.monitorIdle) {
          const ia = E.prop(cfg.monitorIdle);
          idle = E.el('img', { position: 'absolute', left: '50%', top: '50%', height: '42%', transform: 'translate(-50%,-50%)' }, scr); idle.src = ia.url;
        }
        // Scale at which the zoomed-in UI matches a full-frame cover fit, handed to the next act.
        const sw = rect[2] * mw, sh = rect[3] * mh;
        const Z = Math.max(W / sw, H / sh) * 1.04;
        const uh = sa.h * Math.max(sw / sa.w, sh / sa.h);
        const handoffS = (uh * Z) / (sa.h * Math.max(W / sa.w, H / sa.h));
        mon = { group, scr, ui, flash, idle, mw, mh, rect, Z, handoffS };
        if (cfg.phone !== false) phone = E.sprite(band, 'phone', (cfg.phoneSize || 0.66) * H, { zIndex: 4 });
      }
      chart.style.zIndex = 5;

      return {
        handoff: () => (mon ? { screen: cfg.screen || 'dashboard', s: mon.handoffS } : null),
        update(lt, dur) {
          // Band opens from the center like graph paper, then the grid fades.
          const bp = ease.inOutCubic(prog(lt, T.band, T.bandDur));
          const inset = (1 - lerp(0.36, 1, bp)) * H / 2;
          band.style.clipPath = `inset(${inset}px 0px ${inset}px 0px)`;
          gridEl.style.opacity = 1 - prog(lt, T.band + T.bandDur * 0.6, 0.3);
          // Title & subtitle.
          const tp = ease.outCubic(prog(lt, T.title, 0.3)), tout = 1 - prog(lt, T.titleOut, 0.25);
          E.xf(title.box, { x: W / 2, y: (0.155 + (1 - tp) * 0.02) * H, o: tp * (useMonitor ? tout : 1) });
          const stimes = sub.words.map((_, i) => T.sub + i * T.subGap);
          E.revealWords(sub.words, lt, stimes);
          sub.words.forEach((w, i) => { w.style.display = lt >= stimes[i] ? 'inline-block' : 'none'; });
          E.xf(sub.box, { x: W / 2, y: 0.265 * H, o: useMonitor ? tout : 1 });
          // Rules draw out from the center.
          const rp = ease.outCubic(prog(lt, T.rules, 0.4));
          const mIn = useMonitor ? ease.inOutCubic(prog(lt, T.monitorIn, T.monitorDur)) : 0;
          rules.forEach((r, j) => { setRule(r, j ? RULES.bottom : RULES.top, rp); r.style.opacity = 0.85 * (1 - mIn); });
          // Conveyor: row slides right, chart slides in from the left.
          const cp = useChart ? ease.inOutCubic(prog(lt, T.conveyor, T.conveyorDur)) : 0;
          const shift = cp * shiftD;
          // Without a chart, the row drops away as the monitor arrives.
          const rowOut = !useChart && useMonitor ? ease.inCubic(prog(lt, T.monitorIn - 0.25, 0.35)) : 0;
          row.forEach((it, j) => E.xf(it.e, { x: it.cx + shift, y: rowY() + Math.sin(lt * 2 + j) * 2 + rowOut * 0.25 * H, s: 1 - 0.2 * rowOut, o: 1 - rowOut }));
          // Monitor placement over time.
          let mx = W / 2, my = 0.63 * H, ms = 1;
          if (useMonitor) {
            const slide = ease.inOutCubic(prog(lt, T.phoneIn, 0.45));
            mx = lerp(W / 2, 0.6 * W, slide); my = lerp(0.63 * H, 0.6 * H, slide);
            ms = lerp(1.18, 1, mIn);
          }
          // Monitor screen rect in stage coordinates (before zoom).
          const scrRect = (x, y, s) => {
            const r = mon.rect, gx = x - mon.mw * s / 2, gy = y - mon.mh * s / 2;
            return [gx + r[0] * mon.mw * s, gy + r[1] * mon.mh * s, r[2] * mon.mw * s, r[3] * mon.mh * s];
          };
          // Chart: row position → shrinks into the monitor screen.
          const chartX0 = RULES.x0 * W - shiftD + shift, chartY0 = rowY() - 0.15 * H;
          let cx = chartX0, cy = chartY0, cs = 1, csy = 1;
          if (useMonitor && mIn > 0) {
            const sr = scrRect(mx, my, ms);
            const ts = Math.min(sr[2] * 0.86 / span, sr[3] * 0.7 / (0.3 * H));
            cs = lerp(1, ts, mIn);
            cx = lerp(chartX0, sr[0] + (sr[2] - span * ts) / 2, mIn);
            cy = lerp(chartY0, sr[1] + (sr[3] - 0.3 * H * ts) / 2, mIn);
          }
          // CRT switch: chart collapses to a line, the product UI expands from it.
          const sw1 = prog(lt, T.switchAt, 0.12), sw2 = ease.outCubic(prog(lt, T.switchAt + 0.12, 0.18));
          csy = cs * (1 - sw1 * 0.98);
          chart.style.transform = `translate(${cx}px,${cy + (cs - csy) * 0.15 * H}px) scale(${cs},${csy})`;
          chart.style.opacity = useChart ? (sw1 >= 1 ? 0 : 1) : 0;
          if (useMonitor) {
            mon.ui.style.transform = `scaleY(${sw1 < 1 ? 0 : Math.max(0.02, sw2)})`;
            if (mon.idle) mon.idle.style.transform = `translate(-50%,-50%) scaleY(${1 - sw1 * 0.98})`, mon.idle.style.opacity = sw1 >= 1 ? 0 : 1;
            mon.flash.style.opacity = sw1 > 0 && sw2 < 1 ? 1 - sw2 : 0;
            // Zoom until the screen fills the frame.
            const zp = ease.inOutCubic(prog(lt, T.zoomAt, T.zoomDur));
            const r = mon.rect;
            const dx = (r[0] + r[2] / 2 - 0.5) * mon.mw, dy = (r[1] + r[3] / 2 - 0.5) * mon.mh;
            const Z = mon.Z;
            const s = Math.exp(lerp(Math.log(ms), Math.log(Z), zp));
            const sc0x = mx + dx * ms, sc0y = my + dy * ms;
            const scx = lerp(sc0x, W / 2, zp), scy = lerp(sc0y, H / 2, zp);
            E.xf(mon.group, { x: scx - dx * s, y: scy - dy * s, s, o: mIn > 0 ? clamp(mIn * 3) : 0 });
            if (phone) {
              const pp = ease.outCubic(prog(lt, T.phoneIn, 0.5)), po = ease.inCubic(prog(lt, T.zoomAt, T.zoomDur * 0.7));
              E.xf(phone.e, { x: lerp(0.1 * W, 0.33 * W, pp) - po * 0.3 * W, y: lerp(1.3 * H, 0.8 * H, pp) + po * 0.5 * H, r: lerp(-22, -5, pp), o: pp > 0 ? 1 : 0 });
            }
          }
        },
      };
    },
  });

  /* ================= navpill: tilted UI + floating enlarged nav with a clicking cursor ================= */
  E.registerAct('navpill', {
    needs: (cfg) => ({ screens: [cfg.screen || 'dashboard'] }),
    build(cfg, root, ctx) {
      root.style.background = V.brand.color;
      const P = makePlane(root, cfg.screen || 'dashboard');
      const tint = E.el('div', { position: 'absolute', inset: 0, background: V.brand.color, opacity: 0 }, P.plane);
      const items = cfg.items || V.nav || ['Spot', 'Predict', 'Vault', 'Portfolio'];
      const drops = cfg.dropdowns || V.navDropdowns || [];
      const fs = (cfg.fontSize || 0.05) * H;
      const pill = E.el('div', Object.assign({}, E.abs, {
        display: 'flex', gap: fs * 0.35 + 'px', padding: `${fs * 0.32}px ${fs * 0.4}px`, background: 'rgba(7,8,11,0.97)', borderRadius: fs * 0.32 + 'px',
        fontFamily: V.brand.font, fontWeight: V.brand.textWeight, fontSize: fs + 'px', color: '#fff', whiteSpace: 'nowrap', zIndex: 10,
        boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
      }), root);
      const btns = items.map((it) => {
        const b = E.el('div', { padding: `${fs * 0.18}px ${fs * 0.42}px`, borderRadius: fs * 0.22 + 'px' }, pill);
        b.textContent = E.fill(it);
        if (drops.includes(it)) E.el('span', { fontSize: '0.55em', marginLeft: '0.35em', verticalAlign: '0.2em', opacity: 0.8 }, b, '⌄');
        return b;
      });
      const px = W / 2, py = (cfg.pillY || 0.33) * H;
      E.xf(pill, { x: px, y: py });
      const pw = pill.offsetWidth, ph = pill.offsetHeight;
      const centers = btns.map((b) => [px - pw / 2 + b.offsetLeft + b.offsetWidth / 2, py - ph / 2 + b.offsetTop + b.offsetHeight / 2 + fs * 0.22]);
      const cur = makeCursor(root, fs * 1.35);
      const clicks = (cfg.clicks || items).map((c) => Math.max(0, typeof c === 'number' ? c : items.indexOf(c)));
      const step = cfg.step || 0.78, c0 = cfg.cursorStart || 0.95;
      const pose = Object.assign({}, TILT, cfg.pose || {});
      const start = Object.assign({}, FLAT, { s: handoffScale(ctx, cfg) });
      return {
        update(lt, dur) {
          const ip = ease.inOutCubic(prog(lt, 0, 0.6));
          const p = lerpPose(start, pose, ip);
          p.ry += Math.sin(lt * 0.6) * 2 * ip; p.x += lt * 0.004 * ip; p.rz += Math.sin(lt * 0.4) * 1 * ip;
          setPose(P, p, cfg.fadeIn ? clamp(lt / cfg.fadeIn) : 1);
          root.style.background = cfg.fadeIn && lt < cfg.fadeIn ? 'transparent' : V.brand.color;
          tint.style.opacity = 0.8 * ease.outCubic(prog(lt, 0.45, 0.4));
          const pp = ease.outCubic(prog(lt, 0.55, 0.4));
          pill.style.opacity = pp;
          pill.style.transform = `translate(${px}px,${py - (1 - pp) * 0.05 * H}px) translate(-50%,-50%)`;
          // Cursor walks the clicks.
          let x = 0.78 * W, y = 0.95 * H, hover = -1, squish = 0;
          clicks.forEach((ci, k) => {
            const ms = c0 + k * step;
            const e = ease.inOutCubic(prog(lt, ms, step * 0.55));
            if (lt >= ms) { const from = k ? centers[clicks[k - 1]] : [0.78 * W, 0.95 * H]; x = lerp(from[0], centers[ci][0], e); y = lerp(from[1], centers[ci][1], e); if (e >= 1) hover = ci; }
            squish = Math.max(squish, bump(lt - (ms + step * 0.72), 0.16));
          });
          btns.forEach((b, i) => { b.style.background = i === hover ? 'rgba(255,255,255,0.14)' : 'transparent'; });
          setCursor(cur, x, y, 1 - 0.18 * squish, clamp((lt - c0 + 0.2) / 0.2));
        },
      };
    },
  });

  /* ================= screen: product UI shot with camera move, cursor, dropdown, ticker ================= */
  E.registerAct('screen', {
    needs: (cfg) => ({ screens: [cfg.screen || 'dashboard'] }),
    build(cfg, root, ctx) {
      root.style.background = V.brand.color;
      const P = makePlane(root, cfg.screen || 'dashboard');
      const cur = cfg.cursor ? makeCursor(P.plane, P.ph * (cfg.cursorSize || 0.05)) : null;
      let menu = null;
      if (cfg.menu) {
        const m = cfg.menu, fs = P.ph * 0.02;
        const box = E.el('div', Object.assign({}, E.abs, {
          width: (m.width || 0.27) * P.pw + 'px', padding: fs * 0.5 + 'px', background: 'rgba(14,16,22,0.98)', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: fs * 0.7 + 'px', fontFamily: V.brand.font, zIndex: 15, boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
        }), P.plane);
        const rows = (m.items || []).map((it) => {
          const r = E.el('div', { display: 'flex', gap: fs * 0.7 + 'px', alignItems: 'flex-start', padding: `${fs * 0.6}px ${fs * 0.7}px`, borderRadius: fs * 0.45 + 'px' }, box);
          E.el('div', { width: fs * 1.3 + 'px', height: fs * 1.3 + 'px', borderRadius: fs * 0.3 + 'px', border: '2px solid #8b93a3', flex: 'none', marginTop: fs * 0.1 + 'px' }, r);
          const tx = E.el('div', null, r);
          E.el('div', { color: '#fff', fontWeight: V.brand.textWeight, fontSize: fs * 1.05 + 'px' }, tx, E.fill(it.title));
          if (it.desc) E.el('div', { color: '#8b93a3', fontWeight: 400, fontSize: fs * 0.8 + 'px', marginTop: fs * 0.2 + 'px' }, tx, E.fill(it.desc));
          return r;
        });
        box.style.transform = `translate(${m.x * P.pw}px, ${m.y * P.ph}px)`;
        menu = { box, rows, m };
      }
      let ticker = null;
      if (cfg.ticker) {
        const tk = cfg.ticker;
        ticker = E.el('div', Object.assign({}, E.abs, {
          fontFamily: tk.font || "'SF Mono', Menlo, Consolas, monospace", fontSize: (tk.size || 0.064) * P.ph + 'px', color: tk.color || '#e8edf7',
          background: tk.bg || 'transparent', padding: '0 0.2em', whiteSpace: 'nowrap', fontWeight: 500, zIndex: 12,
        }), P.plane);
      }
      const from = Object.assign({}, FLAT, { s: handoffScale(ctx, cfg) }, cfg.from || {}), to = Object.assign({}, FLAT, cfg.to || cfg.from || {});
      return {
        update(lt, dur) {
          const e = ease.inOutSine(prog(lt, 0, dur));
          setPose(P, lerpPose(from, to, e), cfg.fadeIn ? clamp(lt / cfg.fadeIn) : 1);
          root.style.background = cfg.fadeIn && lt < cfg.fadeIn ? 'transparent' : V.brand.color;
          if (cur) {
            const c = cursorAt(cfg.cursor, lt, P.pw, P.ph);
            if (c) setCursor(cur, c.x, c.y, c.s, c.o);
          }
          if (menu) {
            const m = menu.m, p = ease.outCubic(prog(lt, m.at || 0, 0.18)), out = m.until != null ? prog(lt, m.until, 0.12) : 0;
            menu.box.style.opacity = p * (1 - out);
            menu.box.style.transform = `translate(${m.x * P.pw}px, ${m.y * P.ph + (1 - p) * -10}px)`;
            menu.rows.forEach((r, i) => { r.style.background = m.hover === i && lt >= (m.hoverAt ?? m.at ?? 0) ? 'rgba(255,255,255,0.08)' : 'transparent'; });
          }
          if (ticker) {
            const tk = cfg.ticker;
            const beat = Math.floor(lt * (tk.rate || 7));
            let v = tk.value || 79592.23;
            for (let i = 1; i <= beat; i++) v += (E.r2(i, 77) - 0.45) * (tk.step || 0.09);
            const s = (tk.prefix ?? '$') + v.toLocaleString('en-US', { minimumFractionDigits: tk.decimals ?? 2, maximumFractionDigits: tk.decimals ?? 2 }) + (tk.suffix || '');
            if (ticker.textContent !== s) ticker.textContent = s;
            ticker.style.transform = `translate(${tk.x * P.pw}px, ${tk.y * P.ph}px) translate(-50%,-50%)`;
          }
        },
      };
    },
  });

  /* ================= cta: end card with pixel-dissolving props ================= */
  E.registerAct('cta', {
    needs: (cfg) => ({ props: cfg.props || ['wheat', 'coin', 'thumb'] }),
    async build(cfg, root) {
      root.style.background = cfg.theme === 'paper' ? V.brand.paper : V.brand.color;
      const fg = cfg.theme === 'paper' ? V.brand.ink : V.brand.onColor;
      const parts = (cfg.parts || ['Get started', 'on', '{brand}']).map(E.fill);
      const fs = (cfg.fontSize || 0.052) * H;
      const line = E.el('div', Object.assign({}, E.abs, { whiteSpace: 'nowrap', fontFamily: V.brand.displayFont, fontWeight: V.brand.displayWeight, fontSize: fs + 'px', color: fg, letterSpacing: '-0.015em' }), root);
      const spans = parts.map((p) => { const s = E.el('span', { display: 'inline-block', marginRight: '0.26em' }, line); s.textContent = p; return s; });
      spans[spans.length - 1].style.marginRight = '0';
      let logo = null;
      if (V.brand.logo) { logo = E.el('img', { height: '1.05em', verticalAlign: '-0.18em', marginRight: '0.3em' }, null); logo.src = V.brand.logo; spans[spans.length - 1].prepend(logo); }
      E.xf(line, { x: W / 2, y: H / 2 });
      const lw = line.offsetWidth;
      const firstRight = W / 2 - lw / 2 + spans[0].offsetLeft + spans[0].offsetWidth;
      const names = cfg.props || ['wheat', 'coin', 'thumb'];
      const levels = [8, 16, 30];
      for (const n of names) for (const b of levels) await E.pixelated(n, b);
      const ph = (cfg.propSize || 0.12) * H;
      let x = firstRight + W * 0.04;
      const props = names.map((n, i) => {
        const imgs = [E.prop(n), ...levels.map((b) => E.assets['pix:' + n + ':' + b])].map((a) => { const im = E.el('img', Object.assign({}, E.abs, { height: ph + 'px' }), root); im.src = a.url; return im; });
        const w = ph * E.prop(n).w / E.prop(n).h;
        const cx = x + w / 2; x += w + W * 0.02;
        return { imgs, cx, i };
      });
      return {
        update(lt) {
          spans.forEach((s, i) => {
            if (i === 0) { s.style.opacity = ease.outCubic(prog(lt, 0, 0.15)); s.style.transform = ''; return; }
            const at = (cfg.restAt || 0.42) + (i - 1) * 0.07, p = ease.outExpo(prog(lt, at, 0.45));
            s.style.opacity = clamp(p * 2);
            s.style.transform = i === 1 ? `translateY(${(1 - p) * 0.55}em)` : `translateX(${(1 - p) * 0.4}em)`;
          });
          props.forEach(({ imgs, cx, i }) => {
            const st = 0.04 + i * 0.04, level = Math.floor(prog(lt, st, 0.3) * 4);
            imgs.forEach((im, k) => { E.xf(im, { x: cx, y: H / 2, o: k === Math.min(level, 3) && lt < st + 0.38 ? 1 - prog(lt, st + 0.22, 0.14) : 0 }); });
          });
        },
      };
    },
  });
})();
