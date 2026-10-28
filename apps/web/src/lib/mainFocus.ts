import { useEffect, useRef, type MouseEvent } from 'react';

export function focusMain() {
  const main = document.getElementById('main');
  if (!main) return false;
  main.focus();
  return true;
}

/** Cold documents retain the skip link as the first Tab stop; SPA arrivals focus their main. */
export function useMainFocus(path: string) {
  const previous = useRef(path);
  useEffect(() => {
    if (previous.current === path) return;
    previous.current = path;
    if (focusMain()) return;
    // The terminal is lazy-loaded when arriving from the standalone Scan landing.
    const observer = new MutationObserver(() => { if (focusMain()) observer.disconnect(); });
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [path]);
}

/** Blank header clicks reset keyboard traversal without changing interactive controls' focus. */
export function onHeaderBackgroundClick(event: Pick<MouseEvent<HTMLElement>, 'target' | 'currentTarget'>) {
  if (event.target !== event.currentTarget) return;
  document.body.tabIndex = -1;
  document.body.focus({ preventScroll: true });
}
