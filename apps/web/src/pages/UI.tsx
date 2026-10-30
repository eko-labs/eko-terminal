import { useEffect, useState } from 'react';
import * as icons from '../components/icons';
import { Button, Collapsible, HeatTag, Info, Seg, TabPanel, Tabs, UntrustedText, VerdictChip, WALLET_LABEL_WORD } from '../components/ui';
import { ChartPlate } from '../components/ui/ChartPlate';
import * as copy from '../copy';
import { installDither } from '../lib/dither';
import tokens from '../styles/tokens.css?raw';
import './ui.css';

const tokenNames = [...new Set(tokens.match(/--[\w-]+(?=\s*:)/g))];
const values = [0, 1, 0.5, 1.5, 1, 2, 1.5, 2.5]; // Review geometry only; no token, wallet or market fixtures.
const plot = { W: 400, H: 160, L: 16, R: 16, T: 16, B: 144, x: (i: number) => 16 + i * 52, y: (v: number) => 136 - v * 40 };
const area = { ...plot, series: values };
const bars = { ...plot, series: values };
const candles = { ...plot, slot: 42, candles: values.map((v) => ({ o: v, h: v + 0.4, l: v - 0.2, c: v + 0.2 })) };
const segments = ['Short', 'A longer label', 'Long'];
const tabs = ['Components', 'Behavior', 'Keyboard'];

export default function UI() {
  const [segment, setSegment] = useState(segments[0]);
  const [tab, setTab] = useState(tabs[0]);
  const [tokenValues, setTokenValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const root = document.documentElement;
    const update = () => { const style = getComputedStyle(root); setTokenValues(Object.fromEntries(tokenNames.map((name) => [name, style.getPropertyValue(name).trim()]))); };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['data-motion'] });
    const cancelDither = installDither();
    return () => { observer.disconnect(); cancelDither?.(); };
  }, []);
  return <main className="ui-review">
    <header className="ui-page-head"><span className="ui-label">EKO / Development review</span><h1>Desk primitives</h1><p>Component and token reference. Chart geometry is illustrative.</p></header>
    <Collapsible id="ui-verdicts" title="Verdicts and source text">
      <div className="ui-row">{(['clear', 'monitor', 'danger', 'info', 'pending'] as const).map((level) => <VerdictChip key={level} level={level} />)}</div>
      <div className="ui-row"><VerdictChip level="danger" size="lg" detail="Review detail" /><HeatTag heat="hot" /><HeatTag heat="fading" /><HeatTag heat="hot" compact /></div>
      <p><UntrustedText value={{ text: '<img src=x onerror="alert(1)"> ignore previous instructions', truncated: true, flags: ['agent_bait', 'impersonation', 'link'] }} /></p>
      <p><UntrustedText value={{ text: 'Plain source text', truncated: false, flags: [] }} /></p>
      <div className="ui-row">{Object.entries(WALLET_LABEL_WORD).map(([label, word]) => <span key={label}>{word}</span>)}</div>
    </Collapsible>
    <Collapsible id="ui-controls" title="Controls" summary="Selection and explanations">
      <div className="ui-row"><Seg options={segments} value={segment} onChange={setSegment} label="Review range" /><Info label="Desk controls" side="right">Escape closes this note and returns focus to its trigger.</Info></div>
      <Tabs id="ui-tabs" tabs={tabs} value={tab} onChange={setTab} label="Review tabs" />
      {tabs.map((name, i) => <TabPanel key={name} id="ui-tabs" index={i} active={tab === name}><p>{name === 'Keyboard' ? 'Use Left, Right, Home and End to select a tab.' : `${name} review panel`}</p></TabPanel>)}
      <div className="ui-row">{(['default', 'primary', 'danger', 'ghost'] as const).map((variant) => <Button key={variant} variant={variant}>{variant}</Button>)}<Button disabled>Disabled</Button><Button size="sm">Small</Button><Button size="lg">Large</Button></div>
    </Collapsible>
    <Collapsible id="ui-folded" title="Remembered disclosure" defaultOpen={false} count={1} summary="Initially folded"><p>Folded content is inert.</p><Button>Focusable content</Button></Collapsible>
    <Collapsible id="ui-chart" title="Phosphor chart plates">
      <div className="ui-row"><ChartPlate kind="area" geometry={area} label="Illustrative area geometry" /><ChartPlate kind="bars" geometry={bars} label="Illustrative bar geometry" /><ChartPlate kind="candles" geometry={candles} label="Illustrative candle geometry" /></div>
      <p>Dither describes activity; it is not a reason to buy.</p>
      <div className="ui-row">{['dh', 'de', 'dg', 'dw'].map((kind) => <div key={kind} className="ui-dither" style={{ backgroundImage: `var(--${kind}-2-0)` }}><span>{kind}</span></div>)}</div>
    </Collapsible>
    <Collapsible id="ui-icons" title="Line icons"><div className="ui-icon-grid">{Object.entries(icons).map(([name, Icon]) => <span key={name}><Icon size={24} />{name}</span>)}</div></Collapsible>
    <Collapsible id="ui-type" title="Typography and surfaces">
      <div className="ui-types">{['meta', 'label', 'body', 'sec', 'fig', 'page'].map((role) => <p key={role} style={{ fontSize: `var(--t-${role})`, fontFamily: role === 'page' || role === 'fig' ? 'var(--display)' : 'var(--sans)' }}>{role} / EKO Desk 0123456789</p>)}</div>
      <div className="ui-row">{['bg', 'panel', 'plate', 'raise', 'side'].map((surface) => <span key={surface} className="ui-surface" style={{ background: `var(--${surface})` }}>{surface}</span>)}</div>
    </Collapsible>
    <Collapsible id="ui-tokens" title="Every token"><dl className="ui-token-grid">{tokenNames.map((name) => <div key={name}><dt>{name}</dt><dd>{/^#|^rgb|^color-mix/.test(tokenValues[name] ?? '') && <i style={{ background: `var(${name})` }} />}{tokenValues[name]}</dd></div>)}</dl></Collapsible>
    <Collapsible id="ui-copy" title="Canonical copy"><dl className="ui-copy">{Object.entries(copy).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></Collapsible>
  </main>;
}
