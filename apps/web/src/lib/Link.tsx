import type { AnchorHTMLAttributes } from 'react';
import { navigate } from './router';
export function Link({ to, onClick, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return <a {...props} href={to} onClick={(e) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || props.target || props.download) return;
    e.preventDefault(); navigate(to);
  }}>{children}</a>;
}
