/**
 * EKO's LED indicator: a 7×7 panel of round dots running a short looping pattern. This file is the pattern logic
 * only, pure functions from a step number to 49 intensities (0 = unlit, 1 = fully lit), so it can be tested and drawn
 * by anything; components/ui/Led.tsx draws it. Patterns step like an LED panel (about 10 a second) and a lit dot
 * fades over the next two steps (TRAIL), the way a real panel's phosphor lingers.
 */
export const LED_PATTERNS = ['ring', 'snake', 'sweep', 'pulse', 'scan', 'fall', 'sparkle'] as const;
export type LedPattern = typeof LED_PATTERNS[number];
export const LED_N = 7;
export const LED_CELLS = LED_N * LED_N;
/** How much of a dot's light is left one and two steps after it was lit. */
export const TRAIL = [1, 0.55, 0.25] as const;

const at = (x: number, y: number) => y * LED_N + x;
const C = (LED_N - 1) / 2;
const dist = (i: number) => Math.hypot(i % LED_N - C, Math.floor(i / LED_N) - C);

/** The ring: the 16 cells about three dots from the centre, in clockwise order from the top. */
export const RING: readonly number[] = Array.from({ length: LED_CELLS }, (_, i) => i)
  .filter((i) => dist(i) >= 2.5 && dist(i) < 3.5)
  .sort((a, b) => angle(a) - angle(b));
function angle(i: number) { const a = Math.atan2(i % LED_N - C, -(Math.floor(i / LED_N) - C)); return a < 0 ? a + 2 * Math.PI : a; }

/** The snake's track: a spiral from the top-left corner in to the centre (the snake coils in, then back out). */
export const SPIRAL: readonly number[] = (() => {
  const out: number[] = []; let top = 0, left = 0, bottom = LED_N - 1, right = LED_N - 1;
  while (top <= bottom && left <= right) {
    for (let x = left; x <= right; x++) out.push(at(x, top));
    for (let y = top + 1; y <= bottom; y++) out.push(at(right, y));
    if (top < bottom) for (let x = right - 1; x >= left; x--) out.push(at(x, bottom));
    if (left < right) for (let y = bottom - 1; y > top; y--) out.push(at(left, y));
    top++; left++; bottom--; right--;
  }
  return out;
})();
const SNAKE_BODY = [1, 0.78, 0.58, 0.42, 0.28, 0.16];
/** Each column's drop starts this many steps into the fall's cycle, so drops arrive unevenly, like rain. */
const FALL_OFFSET = [0, 9, 4, 12, 2, 7, 11];
const FALL_CYCLE = 14;

/** Steps in one cycle of each pattern; a cycle ends where the next begins seamlessly. */
export const LED_PERIOD: Record<LedPattern, number> = {
  ring: RING.length, snake: 2 * (SPIRAL.length - 1), sweep: 2 * LED_N + 2, pulse: 22, scan: 2 * (LED_N - 1), fall: FALL_CYCLE, sparkle: 16,
};
/** Steps a second each pattern runs at; the shared clock scales these by an instance's speed. */
export const LED_FPS: Record<LedPattern, number> = { ring: 11, snake: 13, sweep: 11, pulse: 11, scan: 10, fall: 10, sparkle: 9 };
/** The frame shown when motion is off, or once a pattern has played its cycles: a recognisable moment of each. */
export const LED_STILL: Record<LedPattern, number> = { ring: 3, snake: 14, sweep: 7, pulse: 11, scan: 3, fall: 6, sparkle: 5 };

const mod = (n: number, m: number) => ((n % m) + m) % m;
const pingPong = (n: number, last: number) => { const k = mod(n, 2 * last); return k <= last ? k : 2 * last - k; };
/** A stable pseudo-random number in [0, 1) for a cell and step, so sparkle is a pure function too. */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** The dots a pattern lights at one step, before the trail. */
function heads(pattern: LedPattern, step: number, out: Float32Array) {
  switch (pattern) {
    case 'ring': {
      // A faint ring so the shape reads, one bright dot chasing round it and a dim one opposite to balance it.
      for (const i of RING) out[i] = 0.2;
      out[RING[mod(step + RING.length / 2, RING.length)]!] = 0.38;
      out[RING[mod(step, RING.length)]!] = 1;
      return;
    }
    case 'snake': {
      const last = SPIRAL.length - 1;
      SNAKE_BODY.forEach((v, k) => { const i = SPIRAL[pingPong(step - k, last)]!; out[i] = Math.max(out[i]!, v); });
      return;
    }
    case 'sweep': {
      // A diagonal band from the top-left corner to the bottom-right, then a short dark pause.
      const k = mod(step, LED_PERIOD.sweep);
      for (let i = 0; i < LED_CELLS; i++) if (i % LED_N + Math.floor(i / LED_N) === k) out[i] = 1;
      return;
    }
    case 'scan': {
      const x = pingPong(step, LED_N - 1);
      for (let y = 0; y < LED_N; y++) out[at(x, y)] = 1;
      return;
    }
    case 'fall': {
      for (let x = 0; x < LED_N; x++) { const y = mod(step + FALL_OFFSET[x]!, FALL_CYCLE); if (y < LED_N) out[at(x, y)] = 1; }
      return;
    }
    case 'sparkle': {
      for (let i = 0; i < LED_CELLS; i++) if (hash01(i, mod(step, 4096)) < 0.075) out[i] = 0.55 + 0.45 * hash01(step, i);
      return;
    }
    case 'pulse': {
      // A disc that swells from the centre and settles back, brighter as it grows: breathing, not blinking.
      const b = (1 - Math.cos((2 * Math.PI * mod(step, LED_PERIOD.pulse)) / LED_PERIOD.pulse)) / 2;
      const r = 0.7 + b * 3.1;
      for (let i = 0; i < LED_CELLS; i++) out[i] = Math.min(1, Math.max(0, (r - dist(i)) / 1.3)) * (0.3 + 0.7 * b);
      return;
    }
  }
}

/** One frame of a pattern: its lit dots at `step` and the fading trail of the two steps before. */
export function ledFrame(pattern: LedPattern, step: number): Float32Array {
  const frame = new Float32Array(LED_CELLS);
  if (pattern === 'pulse' || pattern === 'snake' || pattern === 'ring') {
    // These carry their own shape (a breathing disc, a tapering body, a faint ring); only the ring's head trails.
    heads(pattern, step, frame);
    if (pattern !== 'ring') return frame;
    for (let k = 1; k < TRAIL.length; k++) { const i = RING[mod(step - k, RING.length)]!; frame[i] = Math.max(frame[i]!, TRAIL[k]!); }
    return frame;
  }
  const scratch = new Float32Array(LED_CELLS);
  for (let k = 0; k < TRAIL.length; k++) {
    scratch.fill(0); heads(pattern, step - k, scratch);
    for (let i = 0; i < LED_CELLS; i++) frame[i] = Math.max(frame[i]!, scratch[i]! * TRAIL[k]!);
  }
  return frame;
}

/** The step a pattern is on at time `ms` (one clock for every instance, so panels on screen move together). */
export function ledStep(pattern: LedPattern, ms: number, speed = 1): number {
  return Math.floor((ms / 1000) * LED_FPS[pattern] * speed);
}
/** Whether an instance that started at `startStep` and plays `cycles` cycles has finished (Infinity: never). */
export function ledDone(pattern: LedPattern, startStep: number, step: number, cycles: number): boolean {
  return Number.isFinite(cycles) && step - startStep >= cycles * LED_PERIOD[pattern];
}
