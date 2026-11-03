import { useEffect, useRef, useState, type CSSProperties } from "react";
import { motion, useInView, animate } from "framer-motion";
const cardTexture =
  "/site/media/template/pricing-pro-card-bg.webp";
const buyCryptoIcon =
  "/site/media/template/whyus-buy-crypto.svg";
const timerIcon = "/site/media/template/whyus-timer.svg";
const combDivider =
  "/site/media/template/whyus-comb-divider.svg";
import { popIn, AnimatedLines } from "../lib/animations";
import DotMatrix, { type DotMatrixCrop } from "../lib/DotMatrix";

const TEXT_STEP = 0.03;

const DESIGN_WIDTH = 1510;

// source regions of the 1000x750 texture that the old img (object-cover +
// scale(2.5) from the left/right center) showed in each card
const UPTIME_CROP: DotMatrixCrop = { x: 138, y: 225, w: 290, h: 300 };
const ACCESS_CROP: DotMatrixCrop = { x: 575, y: 225, w: 300, h: 300 };

// mobile cards are 372x176 (420 canvas minus 24px padding each side) - same
// bands of the texture, widened to that ~2.1 aspect
const MOBILE_CARD_WIDTH = 372;
const MOBILE_CARD_HEIGHT = 176;
const MOBILE_UPTIME_CROP: DotMatrixCrop = { x: 80, y: 280, w: 440, h: 208 };
const MOBILE_ACCESS_CROP: DotMatrixCrop = { x: 480, y: 280, w: 440, h: 208 };
const DESIGN_HEIGHT = 1283;
const PAD_X = 65;
const PAD_Y = 150;
const CONTENT_WIDTH = 1380;
const CONTENT_HEIGHT = 983;

const MOBILE_DESIGN_WIDTH = 420;

function useFitScale(designWidth: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setScale(width / designWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [designWidth]);

  return { ref, scale };
}

function useFitScaleAuto(designWidth: number) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [naturalHeight, setNaturalHeight] = useState(0);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setScale(width / designWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [designWidth]);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height) setNaturalHeight(height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { outerRef, innerRef, scale, naturalHeight };
}

/**
 * Counts up to `value`, keeping its exact formatting: only the digits are
 * animated, every other character (%, +, <, /, ms, .) stays where it is.
 */
function CountUp({
  value,
  isInView,
  delay = 0,
  duration = 1.2,
  className,
  style,
}: {
  value: string;
  isInView: boolean;
  delay?: number;
  duration?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const digits = value.replace(/\D/g, "");
  const [shown, setShown] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (!isInView || started.current || !digits) return;
    started.current = true;
    const end = Number(digits);
    const controls = animate(0, end, {
      duration,
      delay,
      ease: "easeOut",
      onUpdate: (v) => setShown(Math.round(v)),
    });
    return () => controls.stop();
  }, [isInView, digits, delay, duration]);

  const text = !digits
    ? value
    : (() => {
        const padded = String(shown).padStart(digits.length, "0");
        let i = 0;
        return value.replace(/\d/g, () => padded[i++]);
      })();

  return (
    <motion.span
      className={className}
      style={style}
      initial={{ opacity: 0 }}
      animate={isInView ? { opacity: 1 } : { opacity: 0 }}
      transition={{ duration: 0.4, delay, ease: "easeOut" }}
    >
      {text}
    </motion.span>
  );
}

function IconWithBrackets({
  icon,
  isInView,
  delay = 0,
}: {
  icon: string;
  isInView: boolean;
  delay?: number;
}) {
  const tick = "absolute h-[10px] w-[13.4px] border-white/70";
  return (
    <motion.div
      className="relative h-[42px] w-[42px]"
      {...popIn(isInView, delay * 1000)}
    >
      <span className={`${tick} left-0 top-0 border-l border-t`} />
      <span className={`${tick} right-0 top-0 border-r border-t`} />
      <span className={`${tick} bottom-0 left-0 border-b border-l`} />
      <span className={`${tick} bottom-0 right-0 border-b border-r`} />
      <img
        src={icon}
        alt=""
        width={24}
        height={24}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      />
    </motion.div>
  );
}

function Stat({
  x,
  y,
  value,
  label,
  isInView,
  delay = 0,
}: {
  x: number;
  y: number;
  value: string;
  label: string;
  isInView: boolean;
  delay?: number;
}) {
  return (
    <div className="absolute" style={{ left: x, top: y }}>
      <CountUp
        value={value}
        isInView={isInView}
        delay={delay}
        className="block font-medium text-white"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 54,
          lineHeight: "51.84px",
          letterSpacing: "-1.62px",
        }}
      />
      <AnimatedLines
        as="div"
        lines={[label]}
        baseDelay={delay + 0.25}
        isInView={isInView}
        className="mt-[10px] lowercase text-white"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 16,
          lineHeight: "15.36px",
          letterSpacing: 0,
        }}
      />
    </div>
  );
}

function Quote({
  x,
  y,
  width,
  quoteLines,
  name,
  role,
  isInView,
  delay = 0,
}: {
  x: number;
  y: number;
  width: number;
  quoteLines: string[];
  name: string;
  role: string;
  isInView: boolean;
  delay?: number;
}) {
  return (
    <div className="absolute" style={{ left: x, top: y, width }}>
      <AnimatedLines
        as="p"
        lines={quoteLines}
        baseDelay={delay}
        isInView={isInView}
        lineClassName="whitespace-nowrap"
        className="text-white"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 24,
          lineHeight: "124%",
          letterSpacing: "-0.24px",
        }}
      />
      <div className="absolute" style={{ left: 14, top: 226 }}>
        <AnimatedLines
          as="div"
          lines={[name]}
          baseDelay={delay + 0.3}
          isInView={isInView}
          className="text-[20px] font-medium text-white"
          style={{ fontFamily: "var(--font-display)" }}
        />
        <AnimatedLines
          as="div"
          lines={[role]}
          baseDelay={delay + 0.33}
          isInView={isInView}
          className="mt-[6px] text-[14px] text-white/60"
          style={{ fontFamily: "var(--font-display)" }}
        />
      </div>
    </div>
  );
}

const verticalLines = [
  { left: 3, top: 239, height: 703 },
  { left: 1380, top: 240, height: 703 },
  { left: 681, top: 240, height: 703 },
  { left: 340, top: 239, height: 350 },
  { left: 1030, top: 591, height: 350 },
];

const horizontalLines = [
  { left: 3, top: 239, width: 1377 },
  { left: 681, top: 589, width: 699 },
  { left: 6, top: 588, width: 675 },
];

function DrawInLines({ isInView }: { isInView: boolean }) {
  return (
    <>
      {verticalLines.map((l, i) => (
        <motion.span
          key={`v-${i}`}
          className="absolute w-px bg-white/20"
          style={{ left: l.left, top: l.top }}
          initial={{ height: 0 }}
          animate={isInView ? { height: l.height } : { height: 0 }}
          transition={{ duration: 0.7, ease: "easeOut", delay: i * 0.07 }}
        />
      ))}
      {horizontalLines.map((l, i) => (
        <motion.span
          key={`h-${i}`}
          className="absolute h-px bg-white/20"
          style={{ left: l.left, top: l.top }}
          initial={{ width: 0 }}
          animate={isInView ? { width: l.width } : { width: 0 }}
          transition={{ duration: 0.7, ease: "easeOut", delay: 0.3 + i * 0.07 }}
        />
      ))}
    </>
  );
}

function MobileStatBlock({
  value,
  label,
  isInView,
  delay = 0,
}: {
  value: string;
  label: string;
  isInView: boolean;
  delay?: number;
}) {
  return (
    <div>
      <CountUp
        value={value}
        isInView={isInView}
        delay={delay}
        className="block font-medium text-white"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 38,
          lineHeight: "36px",
          letterSpacing: "-1.1px",
        }}
      />
      <AnimatedLines
        as="div"
        lines={[label]}
        baseDelay={delay + 0.25}
        isInView={isInView}
        className="mt-[8px] lowercase text-white"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 14,
          lineHeight: "17px",
          letterSpacing: 0,
        }}
      />
    </div>
  );
}

function MobileQuoteBlock({
  quoteLines,
  name,
  role,
  isInView,
  delay = 0,
}: {
  quoteLines: string[];
  name: string;
  role: string;
  isInView: boolean;
  delay?: number;
}) {
  return (
    <div>
      <AnimatedLines
        as="p"
        lines={quoteLines}
        baseDelay={delay}
        isInView={isInView}
        className="text-white"
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 18,
          lineHeight: "138%",
          letterSpacing: "-0.18px",
        }}
      />
      <div className="mt-[18px]">
        <AnimatedLines
          as="div"
          lines={[name]}
          baseDelay={delay + 0.3}
          isInView={isInView}
          className="text-[16px] font-medium text-white"
          style={{ fontFamily: "var(--font-display)" }}
        />
        <AnimatedLines
          as="div"
          lines={[role]}
          baseDelay={delay + 0.33}
          isInView={isInView}
          className="mt-[4px] text-[13px] text-white/60"
          style={{ fontFamily: "var(--font-display)" }}
        />
      </div>
    </div>
  );
}

function EkoBentoMobile() {
  const canvas = useFitScaleAuto(MOBILE_DESIGN_WIDTH);
  const contentRef = useRef<HTMLDivElement>(null);
  const inView = useInView(contentRef, { once: true, amount: 0.2 });

  return (
    <section className="relative block w-full overflow-hidden bg-[#000000] lg:hidden">
      <div
        ref={canvas.outerRef}
        className="relative w-full overflow-hidden"
        style={{ height: canvas.naturalHeight * canvas.scale }}
      >
        <div
          ref={canvas.innerRef}
          className="absolute left-0 top-0"
          style={{
            width: MOBILE_DESIGN_WIDTH,
            transform: `scale(${canvas.scale})`,
            transformOrigin: "top left",
          }}
        >
          <div ref={contentRef} className="flex flex-col px-[24px] py-[56px]">
            {/* header badge */}
            <div className="inline-flex w-fit items-center gap-[6px] whitespace-nowrap border border-white/10 bg-white/10 px-[10px] py-[6px]">
              <span
                className="h-[6px] w-[6px] shrink-0"
                style={{
                  background:
                    "linear-gradient(180deg, #8FCAF0 0%, #D6ECFA 100%)",
                }}
              />
              <span
                className="text-[12px] font-medium uppercase text-white/80"
                style={{ fontFamily: "var(--font-display)" }}
              >
                The EKO stack
              </span>
            </div>

            {/* heading */}
            <div className="mt-[20px]">
              <AnimatedLines
                as="div"
                lines={[
                  "Read the market. Understand the risk. Keep the evidence behind every decision.",
                ]}
                baseDelay={1 * TEXT_STEP}
                isInView={inView}
                className="eko-type-heading font-medium text-white"
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 26,
                  lineHeight: "32px",
                  letterSpacing: "-0.7px",
                }}
              />
              <AnimatedLines
                as="div"
                lines={["Independent minds. Connected intelligence."]}
                baseDelay={3 * TEXT_STEP}
                isInView={inView}
                className="eko-type-heading font-medium text-white/50"
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 26,
                  lineHeight: "32px",
                  letterSpacing: "-0.7px",
                }}
              />
            </div>

            {/* stacked cards, same reading order as desktop */}
            <div className="mt-[32px] flex flex-col">
              {/* 99.99% platform uptime */}
              <div className="relative h-[176px] w-full overflow-hidden">
                <DotMatrix
                  src={cardTexture}
                  width={MOBILE_CARD_WIDTH}
                  height={MOBILE_CARD_HEIGHT}
                  crop={MOBILE_UPTIME_CROP}
                  pitch={6}
                  gain={1.6}
                  radius={70}
                  ambient
                  autoSweepMs={5000}
                  className="absolute left-0 top-0"
                />
                <div className="absolute inset-0 bg-[#000000]/40" />
                <div className="relative flex h-full flex-col justify-center px-[24px]">
                  <MobileStatBlock
                    value="5"
                    label="perspectives behind the signal"
                    isInView={inView}
                    delay={0.35}
                  />
                </div>
              </div>

              {/* 100+ trading pairs */}
              <div className="flex items-center gap-[16px] border-t border-white/10 px-[2px] py-[28px]">
                <IconWithBrackets
                  icon={buyCryptoIcon}
                  isInView={inView}
                  delay={0.55}
                />
                <MobileStatBlock
                  value="3"
                  label="guard states, with reasons"
                  isInView={inView}
                  delay={0.45}
                />
              </div>

              {/* Sophia Bennett quote */}
              <div className="border-t border-white/10 px-[2px] py-[28px]">
                <MobileQuoteBlock
                  quoteLines={[
                    "A move is only the beginning. Follow who is buying, what sits beneath the liquidity, and what leaving could cost. Read the reasons behind the signal.",
                  ]}
                  name="Senses / Market intelligence"
                  role="Wallet activity · Liquidity · Exit costs · Risk · Context"
                  isInView={inView}
                  delay={0.4}
                />
              </div>

              {/* Daniel Carter quote */}
              <div className="border-t border-white/10 px-[2px] py-[28px]">
                <MobileQuoteBlock
                  quoteLines={[
                    "Bring context, policy checks and reported outcomes into one view. Define the limits, review the next action, and keep a trace of how a decision was made.",
                  ]}
                  name="Mission Control / Agent oversight"
                  role="Planned · Policy checks · Approvals · Decision journals"
                  isInView={inView}
                  delay={0.55}
                />
              </div>

              {/* <50ms average execution speed */}
              <div className="flex items-center gap-[16px] border-t border-white/10 px-[2px] py-[28px]">
                <IconWithBrackets
                  icon={timerIcon}
                  isInView={inView}
                  delay={0.7}
                />
                <MobileStatBlock
                  value="1"
                  label="connected decision trail"
                  isInView={inView}
                  delay={0.6}
                />
              </div>

              {/* 24/7 market access */}
              <div className="relative h-[176px] w-full overflow-hidden border-t border-white/10">
                <DotMatrix
                  src={cardTexture}
                  width={MOBILE_CARD_WIDTH}
                  height={MOBILE_CARD_HEIGHT}
                  crop={MOBILE_ACCESS_CROP}
                  pitch={6}
                  gain={1.6}
                  radius={70}
                  ambient
                  autoSweepMs={5000}
                  className="absolute left-0 top-0"
                />
                <div className="absolute inset-0 bg-[#000000]/40" />
                <div className="relative flex h-full flex-col justify-center px-[24px]">
                  <MobileStatBlock
                    value="You"
                    label="set the boundaries"
                    isInView={inView}
                    delay={0.7}
                  />
                </div>
              </div>
            </div>

            {/* bottom comb divider */}
            <motion.img
              src={combDivider}
              alt=""
              className="mt-[32px] w-full"
              style={{ height: 32 }}
              initial={{ y: 24, opacity: 0 }}
              animate={inView ? { y: 0, opacity: 1 } : { y: 24, opacity: 0 }}
              transition={{ duration: 0.6, delay: 0.85, ease: "easeOut" }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

export default function EkoBento() {
  const canvas = useFitScale(DESIGN_WIDTH);
  const contentRef = useRef<HTMLDivElement>(null);
  const inView = useInView(contentRef, { once: true, amount: 0.3 });

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
            transformOrigin: "top left",
          }}
        >
          <div
            className="absolute"
            style={{
              left: PAD_X,
              top: PAD_Y,
              width: CONTENT_WIDTH,
              height: CONTENT_HEIGHT,
            }}
          >
            {/* header */}
            <motion.div
              className="absolute inline-flex items-center gap-[6px] whitespace-nowrap border border-white/10 bg-white/10 px-[10px] py-[6px]"
              style={{ left: 1, top: 0 }}
              {...popIn(inView, 0)}
            >
              <span
                className="h-[6px] w-[6px] shrink-0"
                style={{
                  background:
                    "linear-gradient(180deg, #8FCAF0 0%, #D6ECFA 100%)",
                }}
              />
              <span
                className="text-[13px] font-medium uppercase text-white/80"
                style={{ fontFamily: "var(--font-display)" }}
              >
                The EKO stack
              </span>
            </motion.div>

            <div className="absolute" style={{ left: 1, top: 50, width: 1350 }}>
              <AnimatedLines
                as="div"
                lines={[
                  "Read the market. Understand the risk.",
                  "Keep the evidence behind every decision.",
                ]}
                baseDelay={1 * TEXT_STEP}
                isInView={inView}
                className="eko-type-heading font-medium text-white"
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 42,
                  lineHeight: "40.32px",
                  letterSpacing: "-1.26px",
                }}
              />
              <AnimatedLines
                as="div"
                lines={["Independent minds. Connected intelligence."]}
                baseDelay={3 * TEXT_STEP}
                isInView={inView}
                className="eko-type-heading font-medium text-white/50"
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 42,
                  lineHeight: "40.32px",
                  letterSpacing: "-1.26px",
                }}
              />
            </div>

            {/* grid lines */}
            <DrawInLines isInView={inView} />

            {/* 99.99% platform uptime */}
            <motion.div
              className="absolute overflow-hidden"
              style={{ left: 2, top: 239, width: 338, height: 350 }}
              initial={{ y: 24, opacity: 0 }}
              animate={inView ? { y: 0, opacity: 1 } : { y: 24, opacity: 0 }}
              transition={{ duration: 0.6, delay: 0.15, ease: "easeOut" }}
            >
              <DotMatrix
                src={cardTexture}
                width={338}
                height={350}
                crop={UPTIME_CROP}
                pitch={7}
                gain={1.6}
                radius={90}
                className="absolute left-0 top-0"
              />
              <div className="absolute inset-0 bg-[#000000]/40" />
              <Stat
                x={36}
                y={41}
                value="5"
                label="perspectives behind the signal"
                isInView={inView}
                delay={0.35}
              />
            </motion.div>

            {/* 100+ trading pairs */}
            <div
              className="absolute"
              style={{ left: 343, top: 241, width: 338, height: 350 }}
            >
              <Stat
                x={36}
                y={41}
                value="3"
                label="guard states, with reasons"
                isInView={inView}
                delay={0.45}
              />
              <div className="absolute" style={{ left: 36, top: 273 }}>
                <IconWithBrackets
                  icon={buyCryptoIcon}
                  isInView={inView}
                  delay={0.55}
                />
              </div>
            </div>

            {/* Sophia Bennett quote */}
            <div
              className="absolute"
              style={{ left: 681, top: 239, width: 699, height: 350 }}
            >
              <Quote
                x={28}
                y={50}
                width={620}
                quoteLines={[
                  "A move is only the beginning. Follow who is buying,",
                  "what sits beneath the liquidity, and what leaving",
                  "could cost. Read the reasons behind the signal.",
                ]}
                name="Senses / Market intelligence"
                role="Wallet activity · Liquidity · Exit costs · Risk · Context"
                isInView={inView}
                delay={0.4}
              />
            </div>

            {/* Daniel Carter quote */}
            <div
              className="absolute"
              style={{ left: 6, top: 588, width: 675, height: 352 }}
            >
              <Quote
                x={31}
                y={39}
                width={588}
                quoteLines={[
                  "Bring context, policy checks and reported outcomes",
                  "into one view. Define the limits, review the next action,",
                  "and keep a trace of how a decision was made.",
                ]}
                name="Mission Control / Agent oversight"
                role="Planned · Policy checks · Approvals · Decision journals"
                isInView={inView}
                delay={0.55}
              />
            </div>

            {/* <50ms average execution speed */}
            <div
              className="absolute"
              style={{ left: 681, top: 591, width: 349, height: 350 }}
            >
              <Stat
                x={36}
                y={41}
                value="1"
                label="connected decision trail"
                isInView={inView}
                delay={0.6}
              />
              <div className="absolute" style={{ left: 36, top: 273 }}>
                <IconWithBrackets
                  icon={timerIcon}
                  isInView={inView}
                  delay={0.7}
                />
              </div>
            </div>

            {/* 24/7 market access */}
            <motion.div
              className="absolute overflow-hidden"
              style={{ left: 1030, top: 591, width: 350, height: 350 }}
              initial={{ y: 24, opacity: 0 }}
              animate={inView ? { y: 0, opacity: 1 } : { y: 24, opacity: 0 }}
              transition={{ duration: 0.6, delay: 0.15, ease: "easeOut" }}
            >
              <DotMatrix
                src={cardTexture}
                width={350}
                height={350}
                crop={ACCESS_CROP}
                pitch={7}
                gain={1.6}
                radius={90}
                className="absolute left-0 top-0"
              />
              <div className="absolute inset-0 bg-[#000000]/40" />
              <Stat
                x={36}
                y={41}
                value="You"
                label="set the boundaries"
                isInView={inView}
                delay={0.7}
              />
            </motion.div>

            {/* bottom comb divider */}
            <motion.img
              src={combDivider}
              alt=""
              className="absolute"
              style={{ left: 0, top: 943, width: CONTENT_WIDTH, height: 40 }}
              initial={{ y: 24, opacity: 0 }}
              animate={inView ? { y: 0, opacity: 1 } : { y: 24, opacity: 0 }}
              transition={{ duration: 0.6, delay: 0.85, ease: "easeOut" }}
            />
          </div>
        </div>
      </section>
      <EkoBentoMobile />
    </>
  );
}
