import { useEffect, useRef, type CSSProperties } from 'react'

/**
 * Interactive halftone renderer: resamples an image or a looping video into a
 * grid of dots (dot size = brightness, color = source color) and draws it to a
 * canvas. Near the cursor the dots bulge outward and turn into flickering ASCII
 * glyphs; entering the block sends a "re-assembly" wave with glitchy row shifts
 * across it. Coordinates are in design px - the canvas is sized to
 * `width`/`height` and follows whatever transform:scale() its parent applies.
 */

export type DotMatrixCrop = { x: number; y: number; w: number; h: number }

const GLYPHS = ' .,:;_<>/*+=O#SF'
const SUPERSAMPLE = 3

/**
 * Dot colour is a ramp from dim to lit, read from the landing's tokens (eko.css: --eko-dot-lo/-mid/-hi), so the
 * dither fields sit in the terminal's deep blues instead of flooding the page with its light accent. The fallbacks
 * are the same values.
 */
const RAMP_STEPS = 48
/** a playing video is resampled at most this often (ms): getImageData on every frame was most of the page's main-thread time */
const VIDEO_SAMPLE_MS = 66
/** while the block sits under the opening animation (an inert ancestor) it draws once and checks back this often (ms) */
const COVERED_POLL_MS = 250
const RAMP_FALLBACK = ['#0c2233', '#2c5673', '#5d9fd3'] as const

function hexRgb(value: string, fallback: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim()) ?? /^#?([0-9a-f]{6})$/i.exec(fallback)!
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function dotRamp(el: Element): string[] {
  const css = getComputedStyle(el)
  const [lo, mid, hi] = (['--eko-dot-lo', '--eko-dot-mid', '--eko-dot-hi'] as const).map((name, k) =>
    hexRgb(css.getPropertyValue(name), RAMP_FALLBACK[k]))
  const ramp: string[] = []
  for (let k = 0; k < RAMP_STEPS; k++) {
    const t = k / (RAMP_STEPS - 1)
    const [a, b, u] = t < 0.5 ? [lo, mid, t * 2] : [mid, hi, (t - 0.5) * 2]
    ramp.push(`rgb(${Math.round(a[0] + (b[0] - a[0]) * u)},${Math.round(a[1] + (b[1] - a[1]) * u)},${Math.round(a[2] + (b[2] - a[2]) * u)})`)
  }
  return ramp
}

function hash(a: number, b: number) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return s - Math.floor(s)
}

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

export default function DotMatrix({
  src,
  video = false,
  width,
  height,
  crop,
  cropBasis,
  flipX = false,
  pitch = 10,
  gain = 1.8,
  threshold = 0.08,
  dotScale = 0.9,
  radius = 110,
  sweepOnEnter = true,
  ambient = false,
  autoSweepMs = 0,
  litOnly = false,
  backdrop,
  backdropFade = 0,
  className,
  style,
}: {
  src: string
  video?: boolean
  width: number
  height: number
  /** region of the source (in source px) to show; default = object-cover */
  crop?: DotMatrixCrop
  /** width (px) of the source file the crop was measured on; the crop is scaled to the served file, which can be smaller */
  cropBasis?: number
  flipX?: boolean
  /** distance between dot centers, design px */
  pitch?: number
  /** brightness boost - averaging a source that is itself dotted loses ~half the light */
  gain?: number
  /** cells darker than this stay empty */
  threshold?: number
  /** max dot diameter as a fraction of pitch */
  dotScale?: number
  /** cursor influence radius, design px */
  radius?: number
  sweepOnEnter?: boolean
  /** slow diagonal "breathing" shimmer so the block is alive without a cursor (touch screens) */
  ambient?: boolean
  /** run the re-assembly wave on its own every N ms (0 = only on pointer enter / tap) */
  autoSweepMs?: number
  /**
   * cursor and sweep never light up cells that are empty in the source - set it when
   * the block is layered over other content, otherwise the glyphs around the cursor
   * are drawn (black) on top of whatever lies underneath
   */
  litOnly?: boolean
  /**
   * color that fills the block under the wave's silhouette (every column from its
   * first lit cell down), drawn beneath the dots - darkens whatever lies below
   */
  backdrop?: string
  /** backdrop fades in from transparent over this many design px below the wave's top edge */
  backdropFade?: number
  className?: string
  style?: CSSProperties
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const cols = Math.max(1, Math.round(width / pitch))
    const rows = Math.max(1, Math.round(height / pitch))
    const cellW = width / cols
    const cellH = height / rows
    const count = cols * rows

    // per-cell sampled source brightness 0..1; the colour comes from the ramp
    const lum = new Float32Array(count)
    const ramp = dotRamp(canvas)

    const sampler = document.createElement('canvas')
    sampler.width = cols * SUPERSAMPLE
    sampler.height = rows * SUPERSAMPLE
    const sctx = sampler.getContext('2d', { willReadFrequently: true })
    if (!sctx) return

    // one px per cell; drawn upscaled with smoothing, so the silhouette edge is soft
    const mask = backdrop ? document.createElement('canvas') : null
    if (mask) {
      mask.width = cols
      mask.height = rows
    }

    let source: HTMLImageElement | HTMLVideoElement | null = null
    let sourceReady = false
    let disposed = false

    function sourceSize() {
      if (!source) return { w: 0, h: 0 }
      if (source instanceof HTMLVideoElement) return { w: source.videoWidth, h: source.videoHeight }
      return { w: source.naturalWidth, h: source.naturalHeight }
    }

    function resolveCrop(): DotMatrixCrop {
      if (crop) {
        const k = cropBasis ? sourceSize().w / cropBasis : 1
        return { x: crop.x * k, y: crop.y * k, w: crop.w * k, h: crop.h * k }
      }
      const { w, h } = sourceSize()
      // object-cover
      const s = Math.max(width / w, height / h)
      const cw = width / s
      const ch = height / s
      return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch }
    }

    function sample() {
      if (!source || !sctx) return
      const c = resolveCrop()
      sctx.clearRect(0, 0, sampler.width, sampler.height)
      sctx.save()
      if (flipX) {
        sctx.translate(sampler.width, 0)
        sctx.scale(-1, 1)
      }
      sctx.imageSmoothingEnabled = true
      sctx.imageSmoothingQuality = 'high'
      sctx.drawImage(source, c.x, c.y, c.w, c.h, 0, 0, sampler.width, sampler.height)
      sctx.restore()
      const data = sctx.getImageData(0, 0, sampler.width, sampler.height).data
      const rowStride = sampler.width * 4
      const n = SUPERSAMPLE * SUPERSAMPLE
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          let r = 0
          let g = 0
          let b = 0
          for (let sy = 0; sy < SUPERSAMPLE; sy++) {
            let o = (cy * SUPERSAMPLE + sy) * rowStride + cx * SUPERSAMPLE * 4
            for (let sx = 0; sx < SUPERSAMPLE; sx++) {
              const a = data[o + 3] / 255
              r += data[o] * a
              g += data[o + 1] * a
              b += data[o + 2] * a
              o += 4
            }
          }
          r /= n
          g /= n
          b /= n
          const max = Math.max(r, g, b)
          const i = cy * cols + cx
          lum[i] = Math.min(1, (max / 255) * gain)
        }
      }
      if (mask) buildMask()
    }

    function buildMask() {
      const mctx = mask!.getContext('2d')
      if (!mctx) return
      const img = mctx.createImageData(cols, rows)
      for (let cx = 0; cx < cols; cx++) {
        // top edge = first run of 3 lit cells, so stray sparkles above the dune don't count
        let top = rows
        for (let cy = 0; cy < rows - 2; cy++) {
          const i = cy * cols + cx
          if (lum[i] >= threshold && lum[i + cols] >= threshold && lum[i + 2 * cols] >= threshold) {
            top = cy
            break
          }
        }
        const fadeRows = backdropFade / cellH
        for (let cy = top; cy < rows; cy++) {
          const a = fadeRows > 0 ? smoothstep(0, fadeRows, cy - top) : 1
          img.data[(cy * cols + cx) * 4 + 3] = a * 255
        }
      }
      mctx.putImageData(img, 0, 0)
      mctx.globalCompositeOperation = 'source-in'
      mctx.fillStyle = backdrop!
      mctx.fillRect(0, 0, cols, rows)
      mctx.globalCompositeOperation = 'source-over'
    }

    if (video) {
      const v = document.createElement('video')
      v.src = src
      v.muted = true
      v.loop = true
      v.playsInline = true
      v.autoplay = true
      v.crossOrigin = 'anonymous'
      v.addEventListener('loadeddata', () => {
        sourceReady = true
      })
      source = v
    } else {
      const img = new Image()
      img.decoding = 'async'
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        if (disposed) return
        sourceReady = true
        sample()
        dirty = true
      }
      img.src = src
      source = img
    }

    // pointer state, in design px relative to the canvas
    const pointer = { x: -9999, y: -9999, sx: -9999, sy: -9999, inside: false }
    let hover = 0
    let sweepStart = -1
    let dirty = true
    let visible = false
    let raf = 0
    let lastBucket = -1
    let lastVideoTime = -1
    let lastAmbientTick = -1
    let lastAutoSweep = performance.now()
    let lastSampleAt = -Infinity
    let measure = true
    let lastMeasure = -Infinity
    let poll = 0
    function onResize() {
      measure = true
    }

    function onPointerMove(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const x = ((e.clientX - rect.left) / rect.width) * width
      const y = ((e.clientY - rect.top) / rect.height) * height
      const inside = x >= 0 && y >= 0 && x <= width && y <= height
      if (inside && !pointer.inside) {
        if (sweepOnEnter) sweepStart = performance.now()
        if (pointer.sx < -1000) {
          pointer.sx = x
          pointer.sy = y
        }
      }
      pointer.inside = inside
      pointer.x = x
      pointer.y = y
    }
    function onPointerLeaveWindow() {
      pointer.inside = false
    }
    function onPointerDown(e: PointerEvent) {
      if (e.pointerType === 'mouse') return
      const rect = canvas!.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const x = ((e.clientX - rect.left) / rect.width) * width
      const y = ((e.clientY - rect.top) / rect.height) * height
      if (x < 0 || y < 0 || x > width || y > height) return
      sweepStart = performance.now()
      pointer.x = pointer.sx = x
      pointer.y = pointer.sy = y
      pointer.inside = true
    }
    function onPointerUp(e: PointerEvent) {
      if (e.pointerType !== 'mouse') pointer.inside = false
    }

    function ensureBackingSize(now: number) {
      // Reading layout every frame forced a reflow per frame. Measure on start, after a resize, and twice a second
      // (a parent's fit-to-width scale can change without a window resize).
      if (!measure && now - lastMeasure < 500) return
      measure = false
      lastMeasure = now
      const rect = canvas!.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const bw = Math.max(1, Math.round(rect.width * dpr))
      const bh = Math.max(1, Math.round(rect.height * dpr))
      if (canvas!.width !== bw || canvas!.height !== bh) {
        canvas!.width = bw
        canvas!.height = bh
        dirty = true
      }
    }

    function draw(now: number) {
      if (!ctx) return
      ctx.setTransform(canvas!.width / width, 0, 0, canvas!.height / height, 0, 0)
      ctx.clearRect(0, 0, width, height)
      if (mask) {
        ctx.imageSmoothingEnabled = true
        ctx.drawImage(mask, 0, 0, width, height)
      }

      const sweepT = sweepStart < 0 ? -1 : (now - sweepStart) / 700
      const sweeping = sweepT >= 0 && sweepT < 1.4
      const bucket = Math.floor(now / 70)
      const px = pointer.sx
      const py = pointer.sy
      const r2 = radius * radius
      const baseR = Math.min(cellW, cellH) * 0.5 * dotScale
      const glyphSize = Math.min(cellW, cellH) * 1.25
      ctx.font = `${glyphSize}px 'Fragment Mono', ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'

      for (let cy = 0; cy < rows; cy++) {
        // glitch: during the sweep some rows slide sideways for a moment
        let rowShift = 0
        if (sweeping) {
          const h = hash(cy, bucket)
          if (h < 0.08) rowShift = (hash(cy + 7, bucket) - 0.5) * cellW * 6
        }
        for (let cx = 0; cx < cols; cx++) {
          const i = cy * cols + cx
          const l = lum[i]
          if (litOnly && l < threshold) continue
          let x = (cx + 0.5) * cellW + rowShift
          let y = (cy + 0.5) * cellH

          // cursor influence
          let f = 0
          if (hover > 0.001) {
            const dx = x - px
            const dy = y - py
            const d2 = dx * dx + dy * dy
            if (d2 < r2) {
              const d = Math.sqrt(d2)
              f = hover * (1 - smoothstep(0, radius, d))
              if (d > 0.001) {
                const push = f * cellW * 1.4
                x += (dx / d) * push
                y += (dy / d) * push
              }
            }
          }

          // re-assembly wave, travelling along the diagonal
          let wave = 0
          if (sweeping) {
            const p = (cx / cols + cy / rows) * 0.5
            const front = sweepT - 0.2
            wave = 1 - Math.min(1, Math.abs(p - front) / 0.18)
          }

          let breath = 0
          if (ambient) breath = 0.5 + 0.5 * Math.sin(now / 900 - (cx * 0.35 + cy * 0.2))

          const lit = Math.min(1, l * (0.8 + 0.3 * breath) + f * 0.35 + wave * 0.25)
          if (lit < threshold && f < 0.2 && wave < 0.2) continue

          ctx.fillStyle = ramp[Math.min(RAMP_STEPS - 1, Math.max(0, Math.round(lit * (RAMP_STEPS - 1))))]

          const glyphMode = f > 0.3 || (wave > 0.35 && hash(i, bucket) < wave)
          if (glyphMode && lit >= threshold * 0.5) {
            const flicker = hash(i, bucket) * 0.35
            const gi = Math.min(GLYPHS.length - 1, Math.max(1, Math.floor((lit + flicker) * (GLYPHS.length - 1))))
            ctx.fillText(GLYPHS[gi], x, y)
            continue
          }
          if (lit < threshold) continue
          const rad = baseR * Math.sqrt(lit) * (1 + f * 0.5)
          ctx.beginPath()
          ctx.arc(x, y, rad, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      lastBucket = bucket
    }

    function frame(now: number) {
      raf = 0
      if (disposed || !visible) return
      ensureBackingSize(now)

      // Under the opening animation nobody sees the block: draw it once, keep the video paused, check back later.
      if (canvas!.closest('[inert]')) {
        if (source instanceof HTMLVideoElement) {
          if (!source.paused) source.pause()
          if (sourceReady && lastVideoTime < 0) {
            lastVideoTime = source.currentTime
            sample()
            dirty = true
          }
        }
        if (sourceReady && dirty) {
          draw(now)
          dirty = false
        }
        poll = window.setTimeout(() => {
          poll = 0
          if (!disposed && visible && !raf) raf = requestAnimationFrame(frame)
        }, COVERED_POLL_MS)
        return
      }
      if (source instanceof HTMLVideoElement && source.paused) source.play().catch(() => {})

      const targetHover = pointer.inside ? 1 : 0
      hover += (targetHover - hover) * 0.12
      if (Math.abs(targetHover - hover) < 0.002) hover = targetHover
      if (pointer.inside) {
        pointer.sx += (pointer.x - pointer.sx) * 0.25
        pointer.sy += (pointer.y - pointer.sy) * 0.25
      }

      if (autoSweepMs > 0 && now - lastAutoSweep > autoSweepMs) {
        lastAutoSweep = now
        sweepStart = now
      }
      const sweeping = sweepStart >= 0 && now - sweepStart < 1000
      const animating = hover > 0.001 || sweeping
      if (source instanceof HTMLVideoElement && sourceReady && source.currentTime !== lastVideoTime && now - lastSampleAt >= VIDEO_SAMPLE_MS) {
        lastVideoTime = source.currentTime
        lastSampleAt = now
        sample()
        dirty = true
      }
      // glyphs flicker on a 70ms clock, so only redraw when that ticks or something moved
      if (animating && (Math.floor(now / 70) !== lastBucket || pointer.inside)) dirty = true
      // ambient shimmer only needs ~30fps
      if (ambient && Math.floor(now / 33) !== lastAmbientTick) {
        lastAmbientTick = Math.floor(now / 33)
        dirty = true
      }
      if (sourceReady && dirty) {
        draw(now)
        dirty = false
      }
      raf = requestAnimationFrame(frame)
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting
        if (source instanceof HTMLVideoElement) {
          if (!visible) source.pause()
        }
        if (visible && !raf && !poll) {
          dirty = true
          measure = true
          raf = requestAnimationFrame(frame)
        }
      },
      { rootMargin: '100px' },
    )
    io.observe(canvas)
    window.addEventListener('resize', onResize, { passive: true })
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerleave', onPointerLeaveWindow)
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })
    window.addEventListener('pointercancel', onPointerUp, { passive: true })

    return () => {
      disposed = true
      io.disconnect()
      cancelAnimationFrame(raf)
      window.clearTimeout(poll)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', onPointerLeaveWindow)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      if (source instanceof HTMLVideoElement) {
        source.pause()
        source.removeAttribute('src')
        source.load()
      }
    }
  }, [src, video, width, height, crop, cropBasis, flipX, pitch, gain, threshold, dotScale, radius, sweepOnEnter, ambient, autoSweepMs, litOnly, backdrop, backdropFade])

  return <canvas ref={canvasRef} className={className} style={{ width, height, display: 'block', ...style }} />
}
