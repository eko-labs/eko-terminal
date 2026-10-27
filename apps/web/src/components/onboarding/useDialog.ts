import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]'));
}

export function prefersReducedMotion(): boolean {
  const attr = document.documentElement.getAttribute('data-motion');
  if (attr === 'off') return true;
  if (attr === 'on') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Modal behaviour for an onboarding surface: moves focus in (to `[data-autofocus]` or the first
 * focusable element), traps Tab, handles Escape, keeps global shortcuts from firing underneath,
 * and restores focus to wherever it was when the surface closes.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, opts: { active?: boolean; onEscape?: () => void; trap?: boolean; restore?: boolean } = {}) {
  const { active = true, trap = true, restore = true } = opts;
  const escRef = useRef(opts.onEscape);
  escRef.current = opts.onEscape;

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const before = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      if (root.contains(document.activeElement)) return;
      const target = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root)[0] ?? root;
      target.focus({ preventScroll: true });
    }, 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && escRef.current) {
        e.preventDefault();
        e.stopPropagation();
        escRef.current();
        return;
      }
      if (e.key === 'Tab' && trap) {
        const list = focusables(root);
        if (!list.length) {
          e.preventDefault();
          return;
        }
        const first = list[0]!;
        const last = list[list.length - 1]!;
        if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      // Keys pressed inside onboarding never reach the workspace's global shortcuts.
      e.stopPropagation();
    };
    root.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      root.removeEventListener('keydown', onKey);
      if (restore && before && document.contains(before) && typeof before.focus === 'function') before.focus({ preventScroll: true });
    };
  }, [active, ref, trap, restore]);
}
