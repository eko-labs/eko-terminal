import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ScrambleText } from '../lib/animations'

/**
 * Interactive layer for the empty cells of the ticker grid: the cursor leaves
 * a fading grey trail of lit cells with ticking mono prices, and resting on a
 * cell unfolds it into a light quote card (spinner, coin, live price). With no
 * cursor over the grid a few cells flicker on their own and now and then one
 * unfolds by itself. Coordinates are in design px of the parent canvas.
 */

export type CellRect = { x: number; y: number; w: number; h: number }

type Cell = CellRect & { base: number; coin: string }

const CARD_COINS: { coin: string; price: number; decimals: number }[] = [
  { coin: 'BTC', price: 64210.52, decimals: 2 },
  { coin: 'ETH', price: 3832.26, decimals: 2 },
  { coin: 'SOL', price: 142.18, decimals: 2 },
  { coin: 'DOGE', price: 0.1243, decimals: 4 },
  { coin: 'XLM', price: 0.1102, decimals: 4 },
  { coin: 'EOS', price: 0.7134, decimals: 4 },
  { coin: 'MATIC', price: 0.5218, decimals: 4 },
  { coin: 'USDC', price: 1.0001, decimals: 4 },
]
const COIN_BY_NAME = Object.fromEntries(CARD_COINS.map((c) => [c.coin, c]))

const TICK_MS = 650
const DWELL_MS = 420
const AMBIENT_EVERY_MS = 850
const AMBIENT_LIFE_MS = 1700
const AMBIENT_MAX = 3
const AMBIENT_CARD_EVERY_MS = 5200
const AMBIENT_CARD_LIFE_MS = 2800
const CARD_INSET = 7

function hash(a: number, b: number) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return s - Math.floor(s)
}

function intersects(a: CellRect, b: CellRect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function formatPrice(value: number, decimals: number) {
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export default function TickerCells({
  colEdges,
  rowEdges,
  width,
  height,
  blocked,
}: {
  colEdges: number[]
  rowEdges: number[]
  width: number
  height: number
  /** regions whose cells stay dark (swap widget, texture tiles) */
  blocked: CellRect[]
}) {
  const layerRef = useRef<HTMLDivElement>(null)
  const cols = colEdges.length - 1

  const cells = useMemo<(Cell | null)[]>(() => {
    const out: (Cell | null)[] = []
    for (let r = 0; r < rowEdges.length - 1; r++) {
      for (let c = 0; c < cols; c++) {
        const rect = { x: colEdges[c], y: rowEdges[r], w: colEdges[c + 1] - colEdges[c], h: rowEdges[r + 1] - rowEdges[r] }
        const i = r * cols + c
        out.push(
          blocked.some((b) => intersects(rect, b))
            ? null
            : {
                ...rect,
                base: 100 + hash(i, 1) * 170,
                coin: CARD_COINS[Math.floor(hash(i, 2) * CARD_COINS.length)].coin,
              },
        )
      }
    }
    return out
  }, [colEdges, rowEdges, cols, blocked])

  const freeCells = useMemo(() => cells.flatMap((c, i) => (c ? [i] : [])), [cells])

  const [hot, setHot] = useState<number | null>(null)
  const [card, setCard] = useState<number | null>(null)
  const [ambient, setAmbient] = useState<number[]>([])
  const [tick, setTick] = useState(0)
  const [visible, setVisible] = useState(false)

  // pointer -> cell under it, in design px of the scaled canvas
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const layer = layerRef.current
      if (!layer) return
      const rect = layer.getBoundingClientRect()
      if (!rect.width) return
      const x = ((e.clientX - rect.left) / rect.width) * width
      const y = ((e.clientY - rect.top) / rect.height) * height
      let next: number | null = null
      if (x >= 0 && y >= 0 && x < width && y < rowEdges[rowEdges.length - 1]) {
        const c = colEdges.findIndex((edge, k) => x >= edge && x < colEdges[k + 1])
        const r = rowEdges.findIndex((edge, k) => y >= edge && y < rowEdges[k + 1])
        const i = r * cols + c
        if (c >= 0 && r >= 0 && cells[i]) next = i
      }
      setHot(next)
    }
    function onLeave() {
      setHot(null)
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
    }
  }, [cells, colEdges, rowEdges, cols, width, height])

  useEffect(() => {
    const el = layerRef.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // prices tick only while the grid is on screen
  useEffect(() => {
    if (!visible) return
    const id = window.setInterval(() => setTick((t) => t + 1), TICK_MS)
    return () => window.clearInterval(id)
  }, [visible])

  // resting on a cell unfolds it; moving on folds it back
  useEffect(() => {
    if (hot === null) {
      setCard(null)
      return
    }
    setCard((c) => (c === hot ? c : null))
    const id = window.setTimeout(() => setCard(hot), DWELL_MS)
    return () => window.clearTimeout(id)
  }, [hot])

  // idle life: a few cells flicker and now and then one unfolds on its own
  const idle = visible && hot === null
  useEffect(() => {
    if (!idle || !freeCells.length) {
      setAmbient([])
      return
    }
    const timers: number[] = []
    const flicker = window.setInterval(() => {
      const i = freeCells[Math.floor(Math.random() * freeCells.length)]
      setAmbient((a) => (a.length >= AMBIENT_MAX || a.includes(i) ? a : [...a, i]))
      timers.push(window.setTimeout(() => setAmbient((a) => a.filter((x) => x !== i)), AMBIENT_LIFE_MS))
    }, AMBIENT_EVERY_MS)
    const unfold = window.setInterval(() => {
      const i = freeCells[Math.floor(Math.random() * freeCells.length)]
      setCard(i)
      timers.push(window.setTimeout(() => setCard((c) => (c === i ? null : c)), AMBIENT_CARD_LIFE_MS))
    }, AMBIENT_CARD_EVERY_MS)
    return () => {
      window.clearInterval(flicker)
      window.clearInterval(unfold)
      timers.forEach(window.clearTimeout)
    }
  }, [idle, freeCells])

  const hotRow = hot === null ? -1 : Math.floor(hot / cols)
  const hotCol = hot === null ? -1 : hot % cols

  function level(i: number) {
    if (i === hot) return 0.075
    if (ambient.includes(i)) return 0.05
    if (hot !== null) {
      const r = Math.floor(i / cols)
      const c = i % cols
      if (Math.abs(r - hotRow) + Math.abs(c - hotCol) === 1) return 0.025
    }
    return 0
  }

  const cardCell = card === null ? null : cells[card]
  const cardCoin = cardCell ? COIN_BY_NAME[cardCell.coin] : null
  const cardDrift = card === null ? 0 : (hash(card, tick) - 0.5) * 0.004
  const cardChange = card === null ? 0 : (hash(card, 7) - 0.3) * 6 + (hash(card, tick + 1) - 0.5) * 0.3

  return (
    <div
      ref={layerRef}
      className="pointer-events-none absolute left-0 top-0"
      style={{ width, height }}
    >
      {cells.map((cell, i) => {
        if (!cell) return null
        const a = level(i)
        const showNumber = i === hot || ambient.includes(i)
        const price = cell.base * (1 + (hash(i, tick) - 0.5) * 0.01)
        return (
          <div
            key={i}
            className="absolute flex items-center justify-center"
            style={{
              left: cell.x + 1,
              top: cell.y + 1,
              width: cell.w - 1,
              height: cell.h - 1,
              backgroundColor: `rgba(255,255,255,${a})`,
              // light up fast, fade out slowly - that leaves the trail
              transition: `background-color ${a > 0 ? 120 : 1100}ms ease-out`,
            }}
          >
            <span
              className="text-[10px] text-white/40"
              style={{
                fontFamily: 'var(--font-mono-label)',
                opacity: showNumber ? 1 : 0,
                transition: `opacity ${showNumber ? 150 : 900}ms ease-out`,
              }}
            >
              {price.toFixed(2)}
            </span>
          </div>
        )
      })}

      <AnimatePresence>
        {cardCell && cardCoin && (
          <motion.div
            key={card}
            className="absolute flex flex-col items-center justify-between bg-[#e9e9e9] text-black"
            style={{
              left: cardCell.x + CARD_INSET,
              top: cardCell.y + CARD_INSET,
              width: cardCell.w - CARD_INSET * 2,
              height: cardCell.h - CARD_INSET * 2,
              padding: '12px 8px 10px',
              fontFamily: 'var(--font-mono-label)',
            }}
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0, transition: { duration: 0.2, ease: 'easeOut' } }}
            transition={{ type: 'spring', stiffness: 420, damping: 28, mass: 0.7 }}
          >
            <span className="text-[10px] text-black/60">
              {formatPrice(cardCoin.price * (1 + cardDrift), cardCoin.decimals)}
            </span>
            <span className="flex items-center gap-[6px] text-[15px] uppercase">
              <span
                className="h-[9px] w-[9px] animate-spin rounded-full border-[1.5px] border-black border-t-transparent"
                style={{ animationDuration: '0.9s' }}
              />
              <ScrambleText text={cardCoin.coin} duration={380} />
            </span>
            <span className="text-[10px]" style={{ color: cardChange >= 0 ? '#FF6215' : 'rgba(0,0,0,0.45)' }}>
              {cardChange >= 0 ? '+' : ''}
              {cardChange.toFixed(2)}%
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
