import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
const heroGlow = '/site/media/template/hero-glow.mp4'
import ekoMark from '../assets/eko-mark.svg'
import PortfolioDashboard from './EkoDashboard'
import { popIn, AnimatedLines, DrumText, HoverLine, ScrambleText } from '../lib/animations'
import DotMatrix from '../lib/DotMatrix'

const DESIGN_WIDTH = 1512
const DESIGN_HEIGHT = 935

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

const navLinks = ['Discover', 'Senses', 'Harness', 'Terminal', 'Docs']
const navTargets: Record<string, string> = { Discover: '#discover', Senses: '#senses', Harness: '#harness', Terminal: '/radar', Docs: '/site/docs.html' }

function MobileNavLink({ label, onSelect }: { label: string; onSelect: () => void }) {
  const [hovering, setHovering] = useState(false)
  return (
    <a
      href={navTargets[label]}
      onClick={onSelect}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      className="border-b border-white/10 px-[16px] py-[14px] text-left text-[15px] text-white/80 last:border-b-0"
      style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.6px' }}
    >
      <ScrambleText text={label} trigger={hovering} />
    </a>
  )
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

function Crosshair({ x, y, delay = 0 }: { x: number; y: number; delay?: number }) {
  return (
    <motion.span
      className="absolute"
      style={{ left: x - 7.5, top: y - 7.5, width: 15, height: 15 }}
      {...popIn(true, delay)}
    >
      <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-[#969696]" />
      <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-[#969696]" />
    </motion.span>
  )
}

function GuideBand({ top, lineDelay = 0, fadeDelay = 0 }: { top: number; lineDelay?: number; fadeDelay?: number }) {
  const left = 58
  const width = 1394
  const height = 40
  return (
    <>
      {/* top/bottom border lines drawn in */}
      <motion.span
        className="absolute h-px bg-white/20"
        style={{ left, top }}
        initial={{ width: 0 }}
        animate={{ width }}
        transition={{ duration: 0.8, ease: 'easeOut', delay: lineDelay }}
      />
      <motion.span
        className="absolute h-px bg-white/20"
        style={{ left, top: top + height }}
        initial={{ width: 0 }}
        animate={{ width }}
        transition={{ duration: 0.8, ease: 'easeOut', delay: lineDelay + 0.1 }}
      />
      {/* diagonal hatch texture (CSS pattern, not SVG) — fades in with a slide */}
      <motion.div
        className="absolute"
        style={{
          left,
          top,
          width,
          height,
          backgroundImage:
            'repeating-linear-gradient(45deg, rgba(255,255,255,0.2) 0px, rgba(255,255,255,0.2) 1px, transparent 1px, transparent 9px)',
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, ease: 'easeOut', delay: fadeDelay }}
      />
      <Crosshair x={left} y={top} delay={lineDelay * 1000} />
      <Crosshair x={left} y={top + height} delay={(lineDelay + 0.1) * 1000} />
      <Crosshair x={left + width} y={top} delay={lineDelay * 1000} />
      <Crosshair x={left + width} y={top + height} delay={(lineDelay + 0.1) * 1000} />
    </>
  )
}

function CornerBrackets() {
  const corner = 'absolute h-[5px] w-[5px] border-white/50'
  return (
    <>
      <span className={`${corner} -left-px -top-px border-l border-t`} />
      <span className={`${corner} -bottom-px -left-px border-b border-l`} />
      <span className={`${corner} -right-px -top-px border-r border-t`} />
      <span className={`${corner} -bottom-px -right-px border-b border-r`} />
    </>
  )
}

function ScheduleDemoButton({
  x,
  y,
  width,
  delay = 0,
}: {
  x: number
  y: number
  width: number
  delay?: number
}) {
  const [hovering, setHovering] = useState(false)
  return (
    <motion.a href="/radar" aria-label="Open the EKO terminal"
      className="absolute flex h-[30px] items-center justify-center gap-[7px] bg-white px-[9px]"
      style={{ left: x, top: y, width }}
      {...popIn(true, delay)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <DrumText
        text="Open terminal"
        hovering={hovering}
        className="whitespace-nowrap text-[14px] font-medium text-black"
        style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.14px' }}
      />
      <span className="h-[16px] w-px bg-black/10" />
      <ArrowRight color="black" />
    </motion.a>
  )
}

function ContactUsButton({
  x,
  y,
  width,
  delay = 0,
}: {
  x: number
  y: number
  width: number
  delay?: number
}) {
  const [hovering, setHovering] = useState(false)
  return (
    <motion.a href="#discover" aria-label="Discover"
      className="absolute flex h-[30px] items-center justify-center border border-white/10 bg-white/5 px-[9px]"
      style={{ left: x, top: y, width }}
      {...popIn(true, delay)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <CornerBrackets />
      <DrumText
        text="Discover"
        hovering={hovering}
        className="whitespace-nowrap text-[14px] font-medium text-white"
        style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.14px' }}
      />
    </motion.a>
  )
}

const CHROME_BAR_HEIGHT = 28
// PortfolioDashboard's canvas is 718.4 tall, but real content (through the Open
// Positions table) ends around y≈511 — the rest is empty background. Crop to
// this height instead of the full canvas so no blank space shows below the card.
const DASHBOARD_CROP_HEIGHT = 535

function MobileHero() {
  const mobile = useFitScaleAuto(MOBILE_DESIGN_WIDTH)
  const [badgeHovering, setBadgeHovering] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const contentWidth = MOBILE_DESIGN_WIDTH - 40
  const windowInset = 14
  const dashboardWidth = contentWidth - windowInset * 2
  const dashboardScale = dashboardWidth / 948
  const windowHeight = CHROME_BAR_HEIGHT + DASHBOARD_CROP_HEIGHT * dashboardScale + windowInset
  // dot-matrix glow video behind the window, edge to edge, from 60px under its
  // top edge down through the 20px bottom padding
  const glowTop = 60
  const glowHeight = windowHeight - glowTop + 20

  return (
    <section className="eko-hero eko-hero-mobile relative block w-full overflow-hidden lg:hidden">
      <div
        ref={mobile.outerRef}
        className="relative w-full overflow-hidden"
        style={{
          height: mobile.naturalHeight * mobile.scale,
          background: 'linear-gradient(180deg, #000000 0%, #0C151B 62.5%, #223341 100%)',
        }}
      >
        <div
          ref={mobile.innerRef}
          className="absolute left-0 top-0 flex flex-col"
          style={{
            width: MOBILE_DESIGN_WIDTH,
            transform: `scale(${mobile.scale})`,
            transformOrigin: 'top left',
            padding: '20px',
          }}
        >
          {/* nav */}
          <div className="relative flex items-center justify-between">
            <div className="eko-brand">
              <img src={ekoMark} alt="" width={36} height={22} />
              <span
                className="eko-brand-text eko-wordmark ml-[14px] text-[19px] text-white"
                style={{ letterSpacing: '-0.38px' }}
              >
                EKO
              </span>
            </div>
            <button
              type="button"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className="relative z-[40] flex h-[36px] w-[36px] items-center justify-center border border-white/15 bg-white/5"
            >
              <motion.span
                className="absolute h-px w-[16px] bg-white/70"
                style={{ left: 10, right: 10 }}
                animate={menuOpen ? { top: 17, rotate: 45 } : { top: 14, rotate: 0 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
              />
              <motion.span
                className="absolute h-px w-[16px] bg-white/70"
                style={{ left: 10, right: 10 }}
                animate={menuOpen ? { top: 17, rotate: -45 } : { top: 20, rotate: 0 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
              />
            </button>

            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  className="absolute inset-x-0 top-full z-30 mt-[10px] flex flex-col overflow-hidden border border-white/10 bg-[#0c0d10]/95 backdrop-blur-[20px]"
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                >
                  {navLinks.map((label) => (
                    <MobileNavLink key={label} label={label} onSelect={() => setMenuOpen(false)} />
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* badge */}
          <motion.div
            className="mt-[28px] inline-flex w-fit items-center gap-[6px] whitespace-nowrap border border-white/10 bg-white/10 px-[10px] py-[6px]"
            {...popIn(true, 50)}
            onMouseEnter={() => setBadgeHovering(true)}
            onMouseLeave={() => setBadgeHovering(false)}
          >
            <span
              className="h-[6px] w-[6px] shrink-0"
              style={{ background: 'linear-gradient(180deg, #8FCAF0 0%, #D6ECFA 100%)' }}
            />
            <DrumText
              text="EKO / Signal Discovery"
              hovering={badgeHovering}
              className="text-[12px] font-medium uppercase text-white/80"
              style={{ fontFamily: 'var(--font-display)' }}
            />
          </motion.div>

          {/* headline */}
          <AnimatedLines
            as="h1"
            lines={['Every move', 'has a cause.']}
            isInView={true}
            lineStyle={{ marginBottom: '-0.2em' }}
            className="mt-[16px] font-medium text-white"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 34,
              lineHeight: '36px',
              letterSpacing: '-1px',
            }}
          />

          {/* description */}
          <AnimatedLines
            as="p"
            lines={[
              'A trench terminal for Elysium. Every new Montra launch, checked for scam playbooks.',
            ]}
            isInView={true}
            className="mt-[14px] text-[14px] font-medium text-white/80"
            style={{ fontFamily: 'var(--font-display)', lineHeight: '20px' }}
          />

          {/* CTAs */}
          <div className="mt-[20px] flex items-center gap-[10px]">
            <div className="relative" style={{ width: 151, height: 30 }}>
              <ScheduleDemoButton x={0} y={0} width={151} delay={100} />
            </div>
            <div className="relative" style={{ width: contentWidth - 151 - 10, height: 30 }}>
              <ContactUsButton x={0} y={0} width={contentWidth - 151 - 10} delay={150} />
            </div>
          </div>

          {/* glass card over the dot-matrix glow */}
          <div className="relative mt-[24px]">
          <motion.div
            className="absolute"
            style={{ left: -20, top: glowTop }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.7, delay: 0.6, ease: 'easeOut' }}
          >
            <DotMatrix
              src={heroGlow}
              video
              width={MOBILE_DESIGN_WIDTH}
              height={glowHeight}
              pitch={8}
              gain={1.9}
              radius={80}
              ambient
              autoSweepMs={6000}
            />
          </motion.div>
          <motion.div
            className="hero-glass relative overflow-hidden rounded-[9px] border backdrop-blur-[27px]"
            style={{
              width: contentWidth,
              height: windowHeight,
            }}
            initial={{ y: 30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.7, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="hero-window-dots absolute flex items-center gap-[4px]" style={{ left: 14, top: 11 }}>
              <span className="h-[7px] w-[7px] rounded-full bg-white" />
              <span className="h-[7px] w-[7px] rounded-full bg-white/50" />
              <span className="h-[7px] w-[7px] rounded-full bg-white/20" />
            </div>
            <PortfolioDashboard
              className="hero-radar"
              x={windowInset}
              y={CHROME_BAR_HEIGHT}
              width={dashboardWidth}
              height={DASHBOARD_CROP_HEIGHT * dashboardScale}
              scale={dashboardScale}
              revealDelay={0.3}
            />
          </motion.div>
          </div>
        </div>
      </div>
    </section>
  )
}

export default function Hero() {
  const canvas = useFitScale(DESIGN_WIDTH)
  const [badgeHovering, setBadgeHovering] = useState(false)

  return (
    <>
    <section
      ref={canvas.ref}
      className="eko-hero relative hidden w-full overflow-hidden lg:block"
      style={{ aspectRatio: `${DESIGN_WIDTH} / ${DESIGN_HEIGHT}` }}
    >
      <div
        className="absolute left-0 top-0"
        style={{
          width: DESIGN_WIDTH,
          height: DESIGN_HEIGHT,
          transform: `scale(${canvas.scale})`,
          transformOrigin: 'top left',
          background:
            'linear-gradient(180deg, #000000 0%, #0C151B 62.5%, #223341 100%)',
        }}
      >
        {/* hero illustration: live dot-matrix render of the glow video, reacts to the cursor */}
        <motion.div
          className="absolute overflow-hidden bg-black"
          style={{ left: 59, top: 461, width: 1394, height: 667 }}
          initial={{ y: 50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.7, delay: 1.15, ease: [0.22, 1, 0.36, 1] }}
        >
          <DotMatrix src={heroGlow} video width={1394} height={667} pitch={11} gain={1.9} radius={140} />
        </motion.div>

        {/* glow */}
        <div
          className="absolute rounded-full"
          style={{
            left: 177,
            top: 444,
            width: 948.8,
            height: 978.69,
            background: '#8FCAF0',
            opacity: 0.4,
            filter: 'blur(60px)',
            mixBlendMode: 'screen',
          }}
        />
        <div
          className="absolute rounded-full"
          style={{
            left: 97.01,
            top: 210.61,
            width: 801.72,
            height: 750.04,
            background: 'linear-gradient(180deg, #8FCAF0 0%, #D6ECFA 100%)',
            opacity: 0.3,
            filter: 'blur(50px)',
          }}
        />
        <div
          className="absolute rounded-full"
          style={{
            left: -86.72,
            top: 625.97,
            width: 651.76,
            height: 669.37,
            background: 'linear-gradient(180deg, #8FCAF0 0%, #D6ECFA 100%)',
            opacity: 0.3,
            filter: 'blur(50px)',
          }}
        />

        {/* guide lines */}
        <motion.span
          className="absolute top-0 w-px bg-white/30"
          style={{ left: 58 }}
          initial={{ height: 0 }}
          animate={{ height: DESIGN_HEIGHT }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
        />
        <motion.span
          className="absolute top-0 w-px bg-white/30"
          style={{ left: 1452 }}
          initial={{ height: 0 }}
          animate={{ height: DESIGN_HEIGHT }}
          transition={{ duration: 0.9, ease: 'easeOut', delay: 0.05 }}
        />
        <GuideBand top={87} lineDelay={0.1} fadeDelay={0.15} />
        <GuideBand top={418.75} lineDelay={0.2} fadeDelay={0.25} />

        {/* nav */}
        <div className="eko-brand absolute" style={{ left: 114, top: 24, height: 26 }}>
          <motion.img src={ekoMark} alt="" width={44} height={26} {...popIn(true, 0)} />
          <motion.span
            className="eko-brand-text eko-wordmark ml-[14px] text-[23px] text-white"
            style={{ letterSpacing: '-0.47px' }}
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.5 }}
          >EKO</motion.span>
        </div>

        <div className="absolute flex items-center" role="navigation" aria-label="Main navigation" style={{ left: 308, top: 25, width: 274, height: 24 }}>
          {navLinks.map((label, i) => (
            <HoverLine
              key={label}
              href={navTargets[label]}
              text={label}
              baseDelay={i * 0.06}
              isInView={true}
              effect="scramble"
              className="absolute whitespace-nowrap text-[16px] text-white/70"
              style={{
                left: [0, 90, 174, 265, 358][i],
                fontFamily: 'var(--font-display)',
                letterSpacing: '-0.64px',
              }}
            />
          ))}
        </div>

        <ContactUsButton x={1178} y={22} width={84} delay={50} />
        <ScheduleDemoButton x={1274} y={22} width={151} delay={100} />

        {/* headline */}
        <motion.div
          className="absolute inline-flex items-center gap-[6px] whitespace-nowrap border border-white/10 bg-white/10 px-[10px] py-[6px]"
          style={{ left: 114, top: 180 }}
          {...popIn(true, 150)}
          onMouseEnter={() => setBadgeHovering(true)}
          onMouseLeave={() => setBadgeHovering(false)}
        >
          <span
            className="h-[6px] w-[6px] shrink-0"
            style={{ background: 'linear-gradient(180deg, #8FCAF0 0%, #D6ECFA 100%)' }}
          />
          <DrumText
            text="EKO / Signal Discovery"
            hovering={badgeHovering}
            className="text-[13px] font-medium uppercase text-white/80"
            style={{ fontFamily: 'var(--font-display)' }}
          />
        </motion.div>

        <AnimatedLines
          as="h1"
          lines={['Every move', 'has a cause.']}
          isInView={true}
          lineStyle={{ marginBottom: '-0.2em' }}
          className="absolute font-medium text-white"
          style={{
            left: 114,
            top: 219,
            width: 735,
            fontFamily: 'var(--font-display)',
            fontSize: 62.86,
            lineHeight: '60.34px',
            letterSpacing: '-1.89px',
          }}
        />

        {/* description + CTAs */}
        <AnimatedLines
          as="p"
          lines={[
            'A trench terminal for Elysium.',
            'Every new Montra launch,',
            'scanned for scam playbooks.',
          ]}
          isInView={true}
          lineClassName="whitespace-nowrap"
          className="absolute text-[16px] font-medium text-white"
          style={{
            left: 1014.59,
            top: 226,
            width: 398.13,
            fontFamily: 'var(--font-display)',
            lineHeight: '20px',
          }}
        />

        <ScheduleDemoButton x={1014.59} y={311} width={151} delay={200} />
        <ContactUsButton x={1177.09} y={311} width={95} delay={250} />

        {/* glass card */}
        <motion.div
          className="hero-glass absolute rounded-[9px] border backdrop-blur-[27px]"
          style={{ left: 265, top: 518.24, width: 982, height: 589 }}
          initial={{ y: 50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
        />
        <PortfolioDashboard className="hero-radar" x={282} y={547.24} width={948} height={387} revealDelay={0.45} />
        <motion.div
          className="hero-window-dots absolute flex items-center gap-[1.6px]"
          style={{ left: 283, top: 531.24 }}
          initial={{ y: 50, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="h-[6.76px] w-[6.76px] rounded-full bg-white" />
          <span className="h-[6.76px] w-[6.76px] rounded-full bg-white/50" />
          <span className="h-[6.76px] w-[6.76px] rounded-full bg-white/20" />
        </motion.div>
      </div>
    </section>
    <MobileHero />
    </>
  )
}
