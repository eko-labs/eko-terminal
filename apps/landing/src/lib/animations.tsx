import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ElementType } from 'react'

export function popIn(isInView: boolean, delay: number) {
  return {
    initial: { scale: 0, opacity: 0 },
    animate: isInView ? { scale: 1, opacity: 1 } : { scale: 0, opacity: 0 },
    transition: { type: 'spring' as const, stiffness: 340, damping: 22, mass: 0.8, delay: delay / 1000 },
  }
}

const drumFaceStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  backfaceVisibility: 'hidden',
  WebkitBackfaceVisibility: 'hidden',
}

/**
 * Text that flips like a rolodex drum on hover: the visible face rotates away
 * revealing an identical copy underneath, giving a subtle "refresh" feel.
 */
export function DrumText({
  text,
  hovering,
  className,
  style,
  radius = 9,
  hoverScale = 1,
}: {
  text: string
  hovering: boolean
  className?: string
  style?: CSSProperties
  radius?: number
  hoverScale?: number
}) {
  return (
    <span
      className={className}
      style={{ position: 'relative', display: 'inline-block', whiteSpace: 'nowrap', perspective: 240, ...style }}
    >
      <span aria-hidden className="invisible">
        {text}
      </span>
      <span
        style={{
          position: 'absolute',
          inset: 0,
          transformStyle: 'preserve-3d',
          transition: hovering ? 'transform 0.5s cubic-bezier(0.65, 0, 0.35, 1)' : 'none',
          transform: hovering ? `rotateX(180deg) scale(${hoverScale})` : 'rotateX(0deg) scale(1)',
        }}
      >
        <span style={{ ...drumFaceStyle, transform: `translateZ(${radius}px)` }}>{text}</span>
        <span style={{ ...drumFaceStyle, transform: `rotateX(180deg) translateZ(${radius}px)` }}>{text}</span>
      </span>
    </span>
  )
}

/**
 * A single line of text that fades/slides in like `AnimatedLines` on mount,
 * and flips via `DrumText` on hover — for nav links, footer links, and other
 * loose (non-boxed) clickable text where hovering the glyphs themselves is
 * the natural hover target. className/style go straight on the animated
 * `Tag` (e.g. for `absolute`/`left` positioning), with `DrumText` as its only
 * child — no extra clipping wrapper, since nesting one around `DrumText`'s
 * own nested inline-blocks was cropping the text on narrower containers.
 */
export function HoverLine({
  text,
  href,
  as = 'div',
  baseDelay = 0,
  isInView,
  className,
  style,
  effect = 'drum',
}: {
  text: string
  href?: string
  as?: 'div' | 'span'
  baseDelay?: number
  isInView: boolean
  className?: string
  style?: CSSProperties
  effect?: 'drum' | 'scramble'
}) {
  const [hovering, setHovering] = useState(false)
  const MotionTag = href ? motion.a : as === 'span' ? motion.span : motion.div
  return (
    <MotionTag
      href={href}
      className={className}
      style={style}
      initial={{ opacity: 0, y: 10 }}
      animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
      transition={{ duration: 0.5, delay: baseDelay, ease: 'easeOut' }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {effect === 'scramble' ? (
        <ScrambleText text={text} trigger={hovering} style={{ cursor: 'pointer' }} />
      ) : (
        <DrumText text={text} hovering={hovering} style={{ cursor: 'pointer' }} />
      )}
    </MotionTag>
  )
}

export function AnimatedLines({
  lines,
  className,
  style,
  lineClassName,
  lineStyle,
  as: Tag = 'div',
  baseDelay = 0,
  isInView,
}: {
  lines: string[]
  className?: string
  style?: CSSProperties
  lineClassName?: string
  /** merged into each line wrapper - e.g. a negative marginBottom to cancel the descender padding */
  lineStyle?: CSSProperties
  as?: ElementType
  baseDelay?: number
  isInView: boolean
}) {
  return (
    <Tag className={className} style={style}>
      {lines.map((line, i) => (
        <span key={i} className={lineClassName} style={{ display: 'block', overflow: 'hidden', paddingBottom: '0.2em', ...lineStyle }}>
          <motion.span
            style={{ display: 'inline-block' }}
            initial={{ y: '100%', opacity: 0 }}
            animate={isInView ? { y: '0%', opacity: 1 } : { y: '100%', opacity: 0 }}
            transition={{ duration: 0.5, delay: baseDelay + i * 0.08, ease: 'easeOut' }}
          >
            {line}
          </motion.span>
        </span>
      ))}
    </Tag>
  )
}

const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#%&*+<>/'

/**
 * Text that "re-rolls" through random characters, left to right, before
 * settling on `text`. Runs whenever `trigger` flips to true (hover) or `text`
 * itself changes. Width is held by an invisible copy of the final text so the
 * surrounding layout never jumps while the random glyphs are showing.
 */
export function ScrambleText({
  text,
  trigger = false,
  className,
  style,
  duration = 450,
}: {
  text: string
  trigger?: boolean
  className?: string
  style?: CSSProperties
  duration?: number
}) {
  const [display, setDisplay] = useState(text)
  const prevText = useRef(text)
  const prevTrigger = useRef(trigger)
  // Kept outside the effect cleanup: releasing hover mid-run flips `trigger`
  // back to false, and cancelling there would freeze the random glyphs.
  const rafRef = useRef(0)

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  useEffect(() => {
    const textChanged = prevText.current !== text
    const triggered = trigger && !prevTrigger.current
    prevText.current = text
    prevTrigger.current = trigger
    if (!textChanged && !triggered) return

    cancelAnimationFrame(rafRef.current)
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      let out = ''
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        const settleAt = (i + 1) / text.length
        out += ch === ' ' || t >= settleAt ? ch : SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)]
      }
      setDisplay(out)
      if (t < 1) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [text, trigger, duration])

  return (
    <span className={className} style={{ position: 'relative', display: 'inline-block', whiteSpace: 'nowrap', ...style }}>
      <span aria-hidden className="invisible">
        {text}
      </span>
      <span aria-label={text} style={{ position: 'absolute', left: 0, top: 0 }}>
        {display}
      </span>
    </span>
  )
}
