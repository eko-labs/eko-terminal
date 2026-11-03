import { useEffect, useRef, useState } from 'react'
import { motion, useInView } from 'framer-motion'
const waveGlow = '/site/media/template/cta-wave-glow.webp'
import PortfolioDashboard from './EkoDashboard'
import { popIn, AnimatedLines, DrumText } from '../lib/animations'
import DotMatrix from '../lib/DotMatrix'

const DESIGN_WIDTH = 1516
const DESIGN_HEIGHT = 1275

// the wave image used to be drawn at 1720x928.5 * 1.05 from (-10, 346); only the
// part inside the canvas (1526x929 px on screen) was ever visible - this is that
// part in source px of the 2298x1417 texture
const WAVE_CROP = { x: 0, y: 0, w: 1942, h: 1182 }

function useFitScale(designWidth: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setScale(width / designWidth)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [designWidth])

  return { ref, scale }
}

const MOBILE_DESIGN_WIDTH = 420

function useFitScaleAuto(designWidth: number) {
  const outerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const [naturalHeight, setNaturalHeight] = useState(0)

  useEffect(() => {
    const el = outerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setScale(width / designWidth)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [designWidth])

  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height
      if (height) setNaturalHeight(height)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return { outerRef, innerRef, scale, naturalHeight }
}

function ArrowRight({ color }: { color: string }) {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <path
        d="M1 5.5H10M10 5.5L6.5 2M10 5.5L6.5 9"
        stroke={color}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// 1px inside stroke that fades out top to bottom (Figma gradient stroke):
// the gradient is masked down to just the border ring
function GradientStroke({ stops }: { stops: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        borderRadius: 'inherit',
        padding: 1,
        background: `linear-gradient(180deg, ${stops})`,
        mask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
        WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
        WebkitMaskComposite: 'xor',
      }}
    />
  )
}

const TEXT_STEP = 0.03
const CHROME_BAR_HEIGHT = 28
const WINDOW_INSET = 14
const WINDOW_DASHBOARD_WIDTH = 380 - WINDOW_INSET * 2
// PortfolioDashboard's canvas is 718.4 tall, but real content (through the Open
// Positions table) ends around y≈511 — the rest is empty background. Crop to
// this height instead of the full canvas so no blank space shows below the card.
const DASHBOARD_CROP_HEIGHT = 535
const MOBILE_WINDOW_HEIGHT = CHROME_BAR_HEIGHT + (WINDOW_DASHBOARD_WIDTH * DASHBOARD_CROP_HEIGHT) / 948 + WINDOW_INSET

// mobile: dune band of the wave texture behind the lower part of the window,
// running on into the 40px bottom margin
const MOBILE_WAVE_TOP = 90
const MOBILE_WAVE_HEIGHT = MOBILE_WINDOW_HEIGHT - MOBILE_WAVE_TOP + 40
const MOBILE_WAVE_CROP = { x: 150, y: 250, w: 2000, h: 1000 }

export default function CTA() {
  const canvas = useFitScale(DESIGN_WIDTH)
  const mobile = useFitScaleAuto(MOBILE_DESIGN_WIDTH)
  const contentRef = useRef<HTMLDivElement>(null)
  const inView = useInView(contentRef, { once: true, amount: 0.3 })
  const mobileInView = useInView(mobile.innerRef, { once: true, amount: 0.2 })
  const [auditHovering, setAuditHovering] = useState(false)
  const [mobileAuditHovering, setMobileAuditHovering] = useState(false)

  return (
    <>
    <section
      ref={canvas.ref}
      className="relative hidden w-full overflow-hidden bg-[#000000] lg:block"
      style={{ aspectRatio: `${DESIGN_WIDTH} / ${DESIGN_HEIGHT}` }}
    >
      <div
        ref={contentRef}
        className="absolute left-0 top-0"
        style={{
          width: DESIGN_WIDTH,
          height: DESIGN_HEIGHT,
          transform: `scale(${canvas.scale})`,
          transformOrigin: 'top left',
        }}
      >
        {/* warm glow overlay on the dark base */}
        <div
          className="absolute"
          style={{
            left: 0,
            top: 255,
            width: 1516,
            height: 594,
            background: 'linear-gradient(180deg, rgba(143,202,240,0) 0%, rgba(143,202,240,0.2) 100%)',
          }}
        />

        {/* text block */}
        <motion.div
          className="absolute inline-flex items-center gap-[6px] whitespace-nowrap border border-white/10 bg-white/10 px-[10px] py-[6px]"
          style={{ left: 66, top: 0 }}
          {...popIn(inView, 0)}
        >
          <span
            className="h-[6px] w-[6px] shrink-0"
            style={{ background: 'linear-gradient(180deg, #8FCAF0 0%, #D6ECFA 100%)' }}
          />
          <span className="text-[13px] font-medium uppercase text-white/80" style={{ fontFamily: 'var(--font-display)' }}>
            Follow the evidence
          </span>
        </motion.div>

        <AnimatedLines
          as="h2"
          lines={['Less noise.', 'More evidence.']}
          baseDelay={1 * TEXT_STEP}
          isInView={inView}
          className="absolute font-medium text-white"
          style={{ left: 66, top: 46.4, width: 561, fontFamily: 'var(--font-display)', fontSize: 54, lineHeight: '51.84px', letterSpacing: '-1.62px' }}
        />

        <AnimatedLines
          as="p"
          lines={[
            'Explore a token. Compare the context.',
            'Follow the reasons behind the signal.',
          ]}
          baseDelay={2 * TEXT_STEP}
          isInView={inView}
          lineClassName="whitespace-nowrap"
          className="absolute text-[16px] text-white/60"
          style={{ left: 66, top: 174.2, width: 409, fontFamily: 'var(--font-display)', lineHeight: '20px' }}
        />

        <motion.a href="/radar" aria-label="Open EKO"
          className="absolute flex h-[30px] items-center justify-center gap-[7px] bg-white px-[9px]"
          style={{ left: 66, top: 246.2, width: 105 }}
          {...popIn(inView, 120)}
          onMouseEnter={() => setAuditHovering(true)}
          onMouseLeave={() => setAuditHovering(false)}
        >
          <DrumText
            text="Open EKO"
            hovering={auditHovering}
            className="whitespace-nowrap text-[14px] font-medium text-black"
            style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.14px' }}
          />
          <span className="h-[16px] w-px bg-black/10" />
          <ArrowRight color="black" />
        </motion.a>

        {/* wave / dot-pattern glow graphic */}
        <DotMatrix
          src={waveGlow}
          width={1526}
          height={929}
          crop={WAVE_CROP}
          flipX
          pitch={12}
          gain={1.7}
          radius={150}
          litOnly
          backdrop="rgba(2,6,10,0.9)"
          backdropFade={120}
          className="absolute z-[3]"
          style={{ left: -5, top: 346, transform: 'scale(1.05)', transformOrigin: 'left bottom' }}
        />

        {/* glass card illustration */}
        {/* runs past the right edge of the canvas, as in the design */}
        <div
          className="absolute z-[1]"
          style={{
            left: 684,
            top: 13,
            width: 1128,
            height: 697,
            borderRadius: '20px 0 0 20px',
            background: 'rgba(255,255,255,0.04)',
          }}
        >
          <GradientStroke stops="rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.07) 43.4%, rgba(255,255,255,0) 89.9%" />
        </div>
        <div
          className="absolute z-[1] backdrop-blur-[30px]"
          style={{
            left: 690,
            top: 19,
            width: 1114,
            height: 674,
            borderRadius: '16px 0 0 16px',
            background:
              'linear-gradient(rgba(255,255,255,0.04), rgba(255,255,255,0.04)), linear-gradient(180deg, rgba(6,6,6,0.7) 0%, rgba(6,6,6,0.4) 30.4%, rgba(6,6,6,0) 78.1%)',
          }}
        >
          <GradientStroke stops="rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.07) 56%, rgba(255,255,255,0) 115.8%" />
        </div>
        <PortfolioDashboard x={704} y={61} width={1067.9} height={618} scale={1067.9 / 948} radius={8} zIndex={2} />
        <div className="absolute z-[4] flex items-center gap-[8px]" style={{ left: 704, top: 36 }}>
          <span className="h-[10px] w-[10px] rounded-full bg-white" />
          <span className="h-[10px] w-[10px] rounded-full bg-white/50" />
          <span className="h-[10px] w-[10px] rounded-full bg-white/20" />
        </div>

      </div>
    </section>

    <section className="relative block w-full overflow-hidden bg-[#000000] lg:hidden">
      <div
        ref={mobile.outerRef}
        className="relative w-full overflow-hidden"
        style={{ height: mobile.naturalHeight * mobile.scale }}
      >
        <div
          ref={mobile.innerRef}
          className="absolute left-0 top-0"
          style={{
            width: MOBILE_DESIGN_WIDTH,
            transform: `scale(${mobile.scale})`,
            transformOrigin: 'top left',
          }}
        >
          {/* warm glow overlay on the dark base */}
          <div
            className="absolute left-0 top-0"
            style={{
              width: MOBILE_DESIGN_WIDTH,
              height: 320,
              background: 'linear-gradient(180deg, rgba(143,202,240,0) 0%, rgba(143,202,240,0.2) 100%)',
            }}
          />

          <div className="relative flex flex-col items-center px-6 pb-10 pt-14 text-center">
            <motion.div
              className="inline-flex items-center gap-[6px] whitespace-nowrap border border-white/10 bg-white/10 px-[10px] py-[6px]"
              {...popIn(mobileInView, 0)}
            >
              <span
                className="h-[6px] w-[6px] shrink-0"
                style={{ background: 'linear-gradient(180deg, #8FCAF0 0%, #D6ECFA 100%)' }}
              />
              <span className="text-[13px] font-medium uppercase text-white/80" style={{ fontFamily: 'var(--font-display)' }}>
                Follow the evidence
              </span>
            </motion.div>

            <AnimatedLines
              as="h2"
              lines={['Less noise.', 'More evidence.']}
              baseDelay={1 * TEXT_STEP}
              isInView={mobileInView}
              className="mt-6 font-medium text-white"
              style={{ fontFamily: 'var(--font-display)', fontSize: 32, lineHeight: '34px', letterSpacing: '-1px' }}
            />

            <AnimatedLines
              as="p"
              lines={[
                'Explore a token. Compare the context. Follow the reasons behind the signal.',
              ]}
              baseDelay={2 * TEXT_STEP}
              isInView={mobileInView}
              className="mt-4 text-[15px] text-white/60"
              style={{ fontFamily: 'var(--font-display)', lineHeight: '22px' }}
            />

            <motion.a href="/radar" aria-label="Open EKO"
              className="mt-6 flex h-[42px] items-center justify-center gap-[7px] bg-white px-[16px]"
              {...popIn(mobileInView, 120)}
              onMouseEnter={() => setMobileAuditHovering(true)}
              onMouseLeave={() => setMobileAuditHovering(false)}
            >
              <DrumText
                text="Open EKO"
                hovering={mobileAuditHovering}
                className="whitespace-nowrap text-[14px] font-medium text-black"
                style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.14px' }}
              />
              <span className="h-[16px] w-px bg-black/10" />
              <ArrowRight color="black" />
            </motion.a>
          </div>

          <div className="relative pb-10">
          <DotMatrix
            src={waveGlow}
            width={MOBILE_DESIGN_WIDTH}
            height={MOBILE_WAVE_HEIGHT}
            crop={MOBILE_WAVE_CROP}
            flipX
            pitch={8}
            gain={1.7}
            radius={80}
            ambient
            autoSweepMs={6000}
            className="absolute left-0"
            style={{ top: MOBILE_WAVE_TOP }}
          />
          <div
            className="relative z-[1] mx-auto overflow-hidden rounded-[9px] border border-white/15 backdrop-blur-[27px]"
            style={{
              width: 380,
              height: MOBILE_WINDOW_HEIGHT,
              background: 'rgba(255,255,255,0.06)',
            }}
          >
            <div className="absolute flex items-center gap-[4px]" style={{ left: 14, top: 11 }}>
              <span className="h-[7px] w-[7px] rounded-full bg-white" />
              <span className="h-[7px] w-[7px] rounded-full bg-white/50" />
              <span className="h-[7px] w-[7px] rounded-full bg-white/20" />
            </div>
            <PortfolioDashboard
              x={WINDOW_INSET}
              y={CHROME_BAR_HEIGHT}
              width={WINDOW_DASHBOARD_WIDTH}
              height={(WINDOW_DASHBOARD_WIDTH * DASHBOARD_CROP_HEIGHT) / 948}
              scale={WINDOW_DASHBOARD_WIDTH / 948}
              revealDelay={0.2}
            />
          </div>
          </div>
        </div>
      </div>
    </section>
    </>
  )
}
