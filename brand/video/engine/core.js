/* Chaos → Order video engine: core.
 *
 * Every visual is a pure function of time t (seconds). renderFrame(t) sets DOM
 * styles and canvas pixels for that instant, so the preview player and the
 * headless renderer produce identical frames. No CSS transitions/animations.
 */
(function () {
  const V = window.VIDEO;
  const E = (window.E = {});
  E.V = V;
  E.W = (V.size && V.size[0]) || 1920;
  E.H = (V.size && V.size[1]) || 1080;
  E.FPS = V.fps || 30;
  V.brand = Object.assign({
    name: 'Brand', color: '#2267F2', paper: '#F4F3F1', ink: '#111111', onColor: '#FFFFFF',
    font: "'Inter Tight', 'Helvetica Neue', Helvetica, Arial, sans-serif",
    fontUrl: 'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&display=block',
  }, V.brand || {});
  // Display type (headlines, titles, end card) can differ from UI/label type.
  V.brand.displayFont = V.brand.displayFont || V.brand.font;
  if (V.brand.displayWeight == null) V.brand.displayWeight = 600;
  if (V.brand.titleWeight == null) V.brand.titleWeight = V.brand.displayWeight === 600 ? 500 : V.brand.displayWeight;
  if (V.brand.textWeight == null) V.brand.textWeight = 600;
  V.look = Object.assign({ halftone: 0.38, contrast: 1.35, brightness: 0.02, grain: 0.05 }, V.look || {});

  /* ---------- math ---------- */
  E.clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  E.lerp = (a, b, t) => a + (b - a) * t;
  E.prog = (t, start, dur) => (dur <= 0 ? (t >= start ? 1 : 0) : E.clamp((t - start) / dur));
  E.ease = {
    linear: (t) => t,
    inCubic: (t) => t * t * t,
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outQuart: (t) => 1 - Math.pow(1 - t, 4),
    outExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    inExpo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
    inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    outBack: (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  };
  E.hash = (str) => {
    let h = 2166136261;
    str = String(str);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  E.rng = (seed) => {
    let a = typeof seed === 'number' ? seed >>> 0 : E.hash(seed);
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  // Cheap stateless random in [0,1) for integer keys.
  E.r2 = (a, b = 0, c = 0) => {
    let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  E.noise2 = (x, y, seed = 0) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = E.r2(xi, yi, seed), b = E.r2(xi + 1, yi, seed), c = E.r2(xi, yi + 1, seed), d = E.r2(xi + 1, yi + 1, seed);
    return E.lerp(E.lerp(a, b, u), E.lerp(c, d, u), v);
  };
  E.fill = (s) => String(s == null ? '' : s).split('{brand}').join(V.brand.name);

  /* ---------- DOM ---------- */
  E.el = (tag, css, parent, html) => {
    const e = document.createElement(tag);
    if (css) Object.assign(e.style, css);
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  };
  // Position an absolutely-placed element by its center.
  E.xf = (e, o = {}) => {
    const { x = 0, y = 0, s = 1, r = 0, sx, sy } = o;
    e.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%) rotate(${r}deg) scale(${sx == null ? s : sx},${sy == null ? s : sy})`;
    if (o.o !== undefined) e.style.opacity = o.o;
  };
  E.show = (e, on) => { e.style.display = on ? '' : 'none'; };
  E.abs = { position: 'absolute', left: '0px', top: '0px' };

  /* ---------- assets ---------- */
  const assetCache = {};
  E.assets = assetCache;

  function mkCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }
  E.mkCanvas = mkCanvas;

  async function loadImage(src) {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.src = src;
    await im.decode();
    return im;
  }

  function fitCanvas(img, maxDim) {
    const k = Math.min(1, maxDim / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    const c = mkCanvas((img.naturalWidth || img.width) * k, (img.naturalHeight || img.height) * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  function hasTransparency(d) {
    let n = 0;
    for (let i = 3; i < d.length; i += 16) if (d[i] < 250) n++;
    return n > d.length / 16 * 0.01;
  }

  // Flood-fill near-white background from the borders to transparent.
  function keyWhite(d, w, h, thr) {
    const seen = new Uint8Array(w * h);
    const isBg = (p) => {
      const i = p * 4, r = d[i], g = d[i + 1], b = d[i + 2];
      const L = (r + g + b) / 765, sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      return L > thr && sat < 0.14;
    };
    const stack = [];
    const push = (p) => { if (!seen[p] && isBg(p)) { seen[p] = 1; stack.push(p); } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      if (x > 0) push(p - 1); if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w); if (y < h - 1) push(p + w);
    }
    for (let p = 0; p < w * h; p++) {
      if (seen[p]) { d[p * 4 + 3] = 0; continue; }
      const x = p % w, y = (p / w) | 0;
      if ((x > 0 && seen[p - 1]) || (x < w - 1 && seen[p + 1]) || (y > 0 && seen[p - w]) || (y < h - 1 && seen[p + w])) d[p * 4 + 3] = 150;
    }
  }

  function trimCanvas(c) {
    const ctx = c.getContext('2d');
    const { width: w, height: h } = c;
    const d = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return c;
    const out = mkCanvas(x1 - x0 + 5, y1 - y0 + 5);
    out.getContext('2d').drawImage(c, x0 - 2, y0 - 2, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  // Grayscale + contrast + rotated dot screen + grain: the "photocopied collage" look.
  E.halftone = function (c, o = {}) {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const w = c.width, h = c.height;
    const id = ctx.getImageData(0, 0, w, h), d = id.data;
    if (o.key !== false && !hasTransparency(d)) keyWhite(d, w, h, o.keyThreshold || 0.86);
    if (o.halftone !== false) {
      const cell = o.dot || Math.max(3, Math.round(Math.max(w, h) / 190));
      const amt = o.halftoneAmount != null ? o.halftoneAmount : V.look.halftone;
      const con = o.contrast != null ? o.contrast : V.look.contrast;
      const bri = o.brightness != null ? o.brightness : V.look.brightness;
      const grain = V.look.grain;
      const k = Math.SQRT1_2 / cell;
      const rnd = E.rng(o.seed || 7);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] === 0) continue;
        let L = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
        L = E.clamp((L - 0.5) * con + 0.5 + bri);
        const u = (x + y) * k, v = (x - y) * k;
        const du = u - Math.floor(u) - 0.5, dv = v - Math.floor(v) - 0.5;
        const ink = Math.sqrt(du * du + dv * dv) < Math.sqrt((1 - L) / Math.PI) ? 0 : 1;
        const out = L * (1 - amt) + ink * amt + (rnd() - 0.5) * grain;
        d[i] = d[i + 1] = d[i + 2] = Math.round(E.clamp(out) * 255);
      }
    }
    ctx.putImageData(id, 0, 0);
    return o.trim === false ? c : trimCanvas(c);
  };

  const toURL = (c) => new Promise((res) => c.toBlob((b) => res(URL.createObjectURL(b)), 'image/png'));

  async function register(key, canvas) {
    const url = await toURL(canvas);
    const im = new Image(); im.src = url; await im.decode();
    assetCache[key] = { url, w: canvas.width, h: canvas.height, canvas, img: im };
    return assetCache[key];
  }

  // Props: halftoned cutouts. Config value may be a path or {src, halftone, key, trim, dot, contrast, flip}.
  E.loadProp = async function (name) {
    const key = 'prop:' + name;
    if (assetCache[key]) return assetCache[key];
    let spec = (V.props || {})[name];
    if (typeof spec === 'string') spec = { src: spec };
    let c, after = null;
    if (spec && spec.src) {
      try { c = fitCanvas(await loadImage(spec.src), spec.maxSize || 1100); }
      catch (e) { console.warn('prop failed to load, using stand-in:', name, spec.src, e); }
    }
    if (!c) {
      const made = E.standInProp(name);
      c = made.canvas; after = made.after; spec = Object.assign({}, made.opts || {}, spec || {});
      spec.standIn = true;
    }
    spec = spec || {};
    if (spec.flip) { const f = mkCanvas(c.width, c.height), fx = f.getContext('2d'); fx.scale(-1, 1); fx.drawImage(c, -c.width, 0); c = f; }
    c = E.halftone(c, Object.assign({ seed: E.hash(name) }, spec));
    if (after) after(c.getContext('2d'), c);
    const a = await register(key, c);
    a.meta = spec;
    return a;
  };

  // Screens: product UI screenshots, used in color (no halftone).
  E.loadScreen = async function (name) {
    const key = 'screen:' + name;
    if (assetCache[key]) return assetCache[key];
    const src = (V.screens || {})[name];
    let c;
    if (src) {
      try { c = fitCanvas(await loadImage(src), 2400); }
      catch (e) { console.warn('screen failed to load, using stand-in:', name, src, e); }
    }
    if (!c) c = E.standInScreen(name);
    return register(key, c);
  };

  E.prop = (name) => assetCache['prop:' + name] || (() => { throw new Error('prop not preloaded: ' + name); })();
  E.screen = (name) => assetCache['screen:' + name] || (() => { throw new Error('screen not preloaded: ' + name); })();

  // Pixelated copies of a prop for mosaic dissolves.
  E.pixelated = async function (name, block) {
    const key = 'pix:' + name + ':' + block;
    if (assetCache[key]) return assetCache[key];
    const a = E.prop(name);
    const sw = Math.max(2, Math.round(a.w / block)), sh = Math.max(2, Math.round(a.h / block));
    const small = mkCanvas(sw, sh); small.getContext('2d').drawImage(a.canvas, 0, 0, sw, sh);
    const out = mkCanvas(a.w, a.h), ox = out.getContext('2d');
    ox.imageSmoothingEnabled = false; ox.drawImage(small, 0, 0, a.w, a.h);
    return register(key, out);
  };

  /* ---------- films ---------- */
  // A muted <video> seeked frame-exactly. Encode films all-intra (ffmpeg -g 1) for fast, exact seeks.
  E.film = async function (parent, src, css) {
    const v = E.el('video', Object.assign({}, E.abs, { width: '100%', height: '100%', objectFit: 'cover' }, css || {}), parent);
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = src;
    await new Promise((res, rej) => { v.addEventListener('loadeddata', res, { once: true }); v.addEventListener('error', () => rej(new Error('film failed to load: ' + src)), { once: true }); });
    return {
      el: v,
      duration: v.duration,
      seek(t) {
        t = Math.max(0, Math.min(v.duration - 0.01, t));
        if (Math.abs(v.currentTime - t) < 1e-3) return null;
        return new Promise((res) => { v.addEventListener('seeked', res, { once: true }); v.currentTime = t; });
      },
    };
  };

  /* ---------- sprites & text ---------- */
  E.sprite = function (parent, name, h, extraCss) {
    const a = E.prop(name);
    const e = E.el('img', Object.assign({}, E.abs, { height: h + 'px', width: (h * a.w / a.h) + 'px', willChange: 'transform' }, extraCss || {}), parent);
    e.src = a.url;
    e.draggable = false;
    return { e, w: h * a.w / a.h, h, a, name };
  };

  // A line of words that can be revealed one at a time.
  E.textLine = function (parent, text, css) {
    const box = E.el('div', Object.assign({}, E.abs, {
      whiteSpace: 'nowrap', fontFamily: V.brand.displayFont, fontWeight: V.brand.displayWeight, letterSpacing: '-0.01em',
    }, css || {}), parent);
    const words = E.fill(text).split(/\s+/).filter(Boolean).map((w) => {
      const s = E.el('span', { display: 'inline-block', marginRight: '0.26em', willChange: 'transform,opacity' }, box);
      s.textContent = w;
      return s;
    });
    return { box, words };
  };

  // Reveal words: word i appears at times[i] (local seconds).
  E.revealWords = function (words, t, times, opts = {}) {
    const dur = opts.dur || 0.14, rise = opts.rise == null ? 0.22 : opts.rise;
    words.forEach((w, i) => {
      const p = E.ease.outCubic(E.prog(t, times[i], dur));
      w.style.opacity = p;
      w.style.transform = `translateY(${(1 - p) * rise}em)`;
    });
  };

  // Letter-glitch: each letter randomly swaps typeface/size/baseline on a 1/12s beat.
  const GLITCH_FACES = [
    { f: "'Times New Roman', Times, serif", st: 'italic', w: 400 },
    { f: "Georgia, 'Times New Roman', serif", st: 'normal', w: 400 },
    { f: "'Courier New', Courier, monospace", st: 'normal', w: 400 },
    { f: "'Snell Roundhand', 'Brush Script MT', 'Segoe Script', cursive", st: 'normal', w: 400 },
    { f: null, st: 'normal', w: null },
  ];
  E.glitchWord = function (parent, word, css) {
    const box = E.el('span', Object.assign({ display: 'inline-block', whiteSpace: 'nowrap' }, css || {}), parent);
    const letters = [...E.fill(word)].map((ch) => {
      const s = E.el('span', { display: 'inline-block' }, box);
      s.textContent = ch;
      return s;
    });
    return { box, letters };
  };
  E.updateGlitch = function (g, t, intensity, seed = 1) {
    const beat = Math.floor(t * 12);
    g.letters.forEach((s, i) => {
      const r = E.r2(beat, i, seed), r2 = E.r2(beat, i + 50, seed), r3 = E.r2(beat, i + 99, seed);
      if (intensity > 0 && r < 0.55 * intensity) {
        const face = GLITCH_FACES[Math.floor(r2 * GLITCH_FACES.length)];
        s.style.fontFamily = face.f || V.brand.font;
        s.style.fontStyle = face.st;
        s.style.fontWeight = face.w || V.brand.textWeight;
        const up = r3 < 0.33 ? -0.42 : r3 < 0.55 ? 0.22 : 0;
        const sc = up !== 0 ? 0.62 : 0.85 + r3 * 0.5;
        s.style.transform = `translateY(${up}em) scale(${sc})`;
        s.style.textTransform = r3 > 0.8 ? 'uppercase' : 'none';
      } else {
        s.style.fontFamily = ''; s.style.fontStyle = ''; s.style.fontWeight = ''; s.style.transform = ''; s.style.textTransform = '';
      }
    });
  };

  /* ---------- timeline ---------- */
  E.ACTS = {};
  E.registerAct = (type, impl) => { E.ACTS[type] = impl; };

  E.boot = async function () {
    const params = new URLSearchParams(location.search);
    const renderMode = params.has('render');
    if (renderMode) document.documentElement.classList.add('render');
    document.body.style.background = renderMode ? '#000' : '';

    // fonts
    if (V.brand.fontUrl) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = V.brand.fontUrl;
      document.head.appendChild(l);
      await new Promise((res) => { l.onload = res; l.onerror = res; setTimeout(res, 6000); });
    }
    try {
      const fams = [...new Set([V.brand.font, V.brand.displayFont])];
      await Promise.race([
        Promise.all(fams.flatMap((fam) => [600, 500, 700, 400].map((w) => document.fonts.load(`${w} 40px ${fam}`)))),
        new Promise((r) => setTimeout(r, 6000)),
      ]);
      await document.fonts.ready;
    } catch (e) { /* fall back to system fonts */ }

    const stage = document.getElementById('stage');
    stage.style.width = E.W + 'px'; stage.style.height = E.H + 'px';
    stage.style.background = V.brand.paper;
    stage.style.fontFamily = V.brand.font;
    E.stage = stage;

    // Preload every asset the acts ask for.
    const acts = (V.acts || []).map((cfg, i) => ({ cfg, i, impl: E.ACTS[cfg.type] }));
    const missing = acts.filter((a) => !a.impl).map((a) => a.cfg.type);
    if (missing.length) throw new Error('Unknown act type(s): ' + missing.join(', ') + '. Known: ' + Object.keys(E.ACTS).join(', '));
    const props = new Set(), screens = new Set();
    acts.forEach((a) => { const n = a.impl.needs ? a.impl.needs(a.cfg) : {}; (n.props || []).forEach((p) => props.add(p)); (n.screens || []).forEach((s) => screens.add(s)); });
    for (const p of props) await E.loadProp(p);
    for (const s of screens) await E.loadScreen(s);

    // Lay out the timeline: each act starts where the previous ended, minus its overlap.
    let t = 0;
    acts.forEach((a) => {
      a.start = Math.max(0, t - (a.cfg.overlap || 0));
      a.dur = a.cfg.duration;
      a.end = a.start + a.dur;
      t = a.end;
      a.root = E.el('div', Object.assign({}, E.abs, { width: E.W + 'px', height: E.H + 'px', overflow: 'hidden', zIndex: a.i + 1 }), stage);
      a.root.dataset.act = a.cfg.type;
    });
    E.timeline = acts;
    for (const a of acts) {
      const prev = acts[a.i - 1];
      a.inst = await a.impl.build(a.cfg, a.root, { prev: prev && prev.inst, act: a, all: acts });
    }
    // Wait for every <img> to decode so no frame shows a half-loaded image.
    await Promise.all([...stage.querySelectorAll('img')].map((im) => im.decode().catch(() => {})));

    const DURATION = t;
    window.DURATION = DURATION;
    window.FPS = E.FPS;
    // Returns a promise when an act has async work (e.g. seeking a film), so the renderer can wait.
    window.renderFrame = function (time) {
      time = E.clamp(time, 0, DURATION - 1e-6);
      const pending = [];
      for (const a of acts) {
        const on = time >= a.start && time < a.end;
        if (on !== a._on) { a.root.style.display = on ? '' : 'none'; a._on = on; }
        if (on) { const r = a.inst.update(time - a.start, a.dur, time); if (r && r.then) pending.push(r); }
      }
      window.__t = time;
      return pending.length ? Promise.all(pending) : null;
    };
    window.renderFrame(0);
    if (!renderMode) E.player(DURATION);
    window.__ready = true;
  };

  /* ---------- preview player ---------- */
  E.player = function (DURATION) {
    const stage = E.stage;
    const bar = E.el('div', null, document.body); bar.id = 'player';
    const play = E.el('button', null, bar, 'Play');
    const slider = E.el('input', null, bar); slider.type = 'range'; slider.min = 0; slider.max = DURATION; slider.step = 1 / E.FPS; slider.value = 0;
    const label = E.el('span', { fontVariantNumeric: 'tabular-nums', minWidth: '150px' }, bar);
    const actsBar = E.el('div', null, document.body); actsBar.id = 'acts';
    const btns = E.timeline.map((a) => {
      const b = E.el('button', null, actsBar, `${a.i + 1}. ${a.cfg.type}${a.cfg.label ? ' · ' + a.cfg.label : ''}`);
      b.onclick = () => seek(a.start + 0.001);
      return b;
    });
    const hint = E.el('div', { padding: '0 14px 14px', color: '#888' }, document.body,
      'Space play/pause · ←/→ one frame · Shift+←/→ one second · ?t=12.5 in the URL opens at a time');
    let t = 0, playing = false, last = 0;
    const fit = () => { const k = Math.min(1, (window.innerWidth - 0) / E.W, (window.innerHeight - 110) / E.H); stage.style.transform = `scale(${k})`; stage.style.marginBottom = (E.H * k - E.H) + 'px'; stage.style.marginRight = (E.W * k - E.W) + 'px'; };
    fit(); window.addEventListener('resize', fit);
    function seek(nt) {
      t = E.clamp(nt, 0, DURATION - 1 / E.FPS);
      window.renderFrame(t);
      slider.value = t;
      const cur = E.timeline.filter((a) => t >= a.start && t < a.end).map((a) => a.i);
      btns.forEach((b, i) => b.classList.toggle('on', cur.includes(i)));
      label.textContent = `${t.toFixed(2)}s / ${DURATION.toFixed(2)}s · f${Math.round(t * E.FPS)}`;
    }
    function loop(now) {
      if (!playing) return;
      const dt = (now - last) / 1000; last = now;
      let nt = t + dt; if (nt >= DURATION) nt = 0;
      seek(nt); requestAnimationFrame(loop);
    }
    const toggle = () => { playing = !playing; play.textContent = playing ? 'Pause' : 'Play'; if (playing) { last = performance.now(); requestAnimationFrame(loop); } };
    play.onclick = toggle;
    slider.oninput = () => seek(parseFloat(slider.value));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); toggle(); }
      if (e.code === 'ArrowRight') seek(t + (e.shiftKey ? 1 : 1 / E.FPS));
      if (e.code === 'ArrowLeft') seek(t - (e.shiftKey ? 1 : 1 / E.FPS));
    });
    const qt = parseFloat(new URLSearchParams(location.search).get('t'));
    seek(isNaN(qt) ? 0 : qt);
  };
})();
