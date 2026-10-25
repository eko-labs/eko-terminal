import { useEffect, useMemo, useRef, useState } from 'react';
import { enabledRoutes } from '../routes';
import { useShell } from '../store/shell';
import { navigate } from '../lib/router';
import { useApp } from '../store/app';
import { useOnboarding } from '../store/onboarding';
import { IconSearch } from './icons';

interface Cmd {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run(): void;
}

function useCommands(): Cmd[] {
  const st = useApp();
  const flags = useShell((s) => s.config?.flags);
  return useMemo(() => {
    const cmds: Cmd[] = [];
    const go = (p: string, label: string, hint: string) => cmds.push({ id: `nav-${p}`, group: 'Navigate', label, hint, run: () => navigate(p) });
    for (const route of enabledRoutes(flags)) if (!route.path.includes(':') && !route.path.startsWith('/embed/')) go(route.path, route.title, '');
    cmds.push({ id: 'help', group: 'Help', label: 'Keyboard shortcuts', hint: '?', run: () => st.set({ helpOpen: true }) });
    return cmds;
  }, [st, flags]);
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const set = useApp((s) => s.set);
  const cmds = useCommands();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => {
    if (!q) return cmds;
    const terms = q.toLowerCase().split(/\s+/);
    return cmds.filter((c) => terms.every((t) => `${c.group} ${c.label} ${c.hint ?? ''}`.toLowerCase().includes(t)));
  }, [q, cmds]);
  useEffect(() => {
    setI(0);
  }, [q, open]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [i]);
  if (!open) return null;
  const close = () => {
    set({ paletteOpen: false });
    setQ('');
  };
  const run = (c: Cmd | undefined) => {
    if (!c) return;
    close();
    c.run();
  };
  let lastGroup = '';
  return (
    <div className="modal-scrim palette-scrim" onPointerDown={close}>
      <div className="palette" role="dialog" aria-label="Command palette" onPointerDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <IconSearch size={15} />
          <input
            autoFocus
            placeholder="Type a page or command…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setI((x) => Math.min(results.length - 1, x + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setI((x) => Math.max(0, x - 1)));
              else if (e.key === 'Enter') run(results[i]);
              else if (e.key === 'Escape') close();
            }}
            aria-activedescendant={`cmd-${i}`}
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
          />
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list" ref={listRef} id="palette-list" role="listbox">
          {results.map((c, idx) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head ? <div className="palette-group eyebrow">{head}</div> : null}
                <button id={`cmd-${idx}`} data-i={idx} role="option" aria-selected={idx === i} className="palette-row" onMouseEnter={() => setI(idx)} onClick={() => run(c)}>
                  <span>{c.label}</span>
                  {c.hint ? <span className="muted num">{c.hint}</span> : null}
                </button>
              </div>
            );
          })}
          {!results.length ? <div className="empty">No matching commands</div> : null}
        </div>
      </div>
    </div>
  );
}

/** Every keyboard shortcut, in display order. `keys` is space-separated: short tokens render as keys, words like "then" as text. */
export const SHORTCUTS: readonly { keys: string; label: string }[] = [
  { keys: '⌘ K / Ctrl K', label: 'Command palette' },
  { keys: '/', label: 'Search or paste a CA' },
  { keys: 'Esc', label: 'Close inspector or dialog' },
  { keys: 'G then R/M/S', label: 'Go to Radar · Mission · Settings' },
  { keys: '?', label: 'Keyboard shortcuts' },
];

export function ShortcutsHelp() {
  const open = useApp((s) => s.helpOpen);
  const set = useApp((s) => s.set);
  if (!open) return null;
  return (
    <div className="modal-scrim" onPointerDown={() => set({ helpOpen: false })}>
      <div className="modal" role="dialog" aria-label="Keyboard shortcuts" onPointerDown={(e) => e.stopPropagation()} style={{ width: 440 }}>
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          {SHORTCUTS.map(({ keys, label }) => (
            <div key={keys}>
              <dt>
                {keys.split(' ').map((p, i) => (p.length <= 6 && p !== 'then' && (p !== '/' || keys === '/') ? <span key={i} className="kbd">{p}</span> : <span key={i} className="muted"> {p} </span>))}
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
        <div className="modal-actions">
          <button className="btn" onClick={() => set({ helpOpen: false })} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Global keyboard shortcuts. Ignored while typing in inputs. */
export function useShortcuts() {
  useEffect(() => {
    let gPending = 0;
    const h = (e: KeyboardEvent) => {
      const st = useApp.getState();
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        st.set({ paletteOpen: !st.paletteOpen });
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        // Close only the topmost layer: dialogs, then open menus (they close themselves), then a picked signal.
        if (st.paletteOpen || st.helpOpen) st.set({ paletteOpen: false, helpOpen: false });
        else if (document.querySelector('.menu, .modal-scrim, .sig-cluster')) return;
        return;
      }
      if (st.paletteOpen || st.helpOpen) return;
      if (Date.now() - gPending < 900) {
        const map: Record<string, string> = { r: '/radar', m: '/mission', s: '/settings' };
        if (map[e.key]) {
          navigate(map[e.key]!);
          gPending = 0;
          return;
        }
      }
      if (e.key === 'g') {
        gPending = Date.now();
        return;
      }
      if (e.key === '?') return st.set({ helpOpen: true });

    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
}
