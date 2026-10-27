import { afterEach, describe, expect, it, vi } from 'vitest';
const effects = vi.hoisted(() => [] as (() => void | (() => void))[]);
vi.mock('react', () => ({ useEffect: (effect: () => void | (() => void)) => effects.push(effect), useRef: (value: unknown) => ({ current: value }) }));
import { useDialog } from '../onboarding/useDialog';
afterEach(() => { effects.length=0; vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('alerts drawer focus on mobile', () => {
  it('moves focus inside, traps forward/backward Tab, closes on Escape and restores the opener', () => {
    vi.useFakeTimers(); const opener={focus:vi.fn()}, first={focus:vi.fn(),getClientRects:()=>[{}],closest:()=>null}, last={focus:vi.fn(),getClientRects:()=>[{}],closest:()=>null};
    const doc={activeElement:opener,contains:()=>true};
    let key!: (e: KeyboardEvent) => void;
    const root={querySelector:()=>first,querySelectorAll:()=>[first,last],contains:(el:unknown)=>el===first||el===last,addEventListener:(_name:string,handler:(e:KeyboardEvent)=>void)=>{key=handler;},removeEventListener:vi.fn()};
    vi.stubGlobal('document',doc); vi.stubGlobal('window',{setTimeout}); const close=vi.fn();
    useDialog({current:root as unknown as HTMLElement},{onEscape:close}); const cleanup=effects[0]!(); vi.advanceTimersByTime(30); expect(first.focus).toHaveBeenCalledOnce();
    const event=(value:string,shiftKey=false)=>({key:value,shiftKey,preventDefault:vi.fn(),stopPropagation:vi.fn()} as unknown as KeyboardEvent);
    doc.activeElement=last; const tab=event('Tab'); key(tab); expect(tab.preventDefault).toHaveBeenCalledOnce(); expect(first.focus).toHaveBeenCalledTimes(2);
    doc.activeElement=first; key(event('Tab',true)); expect(last.focus).toHaveBeenCalledOnce(); key(event('Escape')); expect(close).toHaveBeenCalledOnce();
    if(typeof cleanup==='function')cleanup(); expect(opener.focus).toHaveBeenCalledWith({preventScroll:true}); expect(root.removeEventListener).toHaveBeenCalledOnce();
  });
});
