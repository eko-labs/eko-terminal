export class SignalRenderer {
  constructor(canvas: HTMLCanvasElement, options?: { capture?: boolean });
  renderAt(time: number): number;
  resize(width?: number, height?: number): boolean;
  destroy(): void;
}
export function scrollToClock(progress: number): number;
export const SCROLL_VIEWS: number;
export const DURATION: number;
export const chapters: readonly { start: number; end: number; name: string; slug: string; rest: number; runway: number }[];
