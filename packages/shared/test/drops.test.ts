import { describe, expect, it } from 'vitest';
import { DropVideoUrlSchema, visibleDrops, type DropManifestEntry } from '../src/drops.js';

const now = Date.parse('2026-10-02T12:00:00Z');
const demo: DropManifestEntry = {
  n: 3, date: '2026-11-10', title: 'Sample paper demo', status: 'demo', requiredFlags: ['arena'],
  demo: { videoUrl: '/demos/drops/sample-paper.mp4', recordedAt: '2026-10-01T12:00:00Z' },
};
const release = { version: 'sample-v1', publishedAt: '2026-10-02T10:00:00Z', url: 'https://example.invalid/releases/sample-v1' };

describe('evidence-bound public Drops', () => {
  it.each(['hidden', 'demo', 'live'] as const)('handles %s with flags off and on', status => {
    const record = { ...demo, status, release };
    expect(visibleDrops([record], { arena: false }, now).map(d => d.status)).toEqual(status === 'hidden' ? [] : ['demo']);
    expect(visibleDrops([record], { arena: true }, now).map(d => d.status)).toEqual(status === 'hidden' ? [] : [status]);
  });

  it('does not promote demo status, elapsed targets, missing evidence or future publication', () => {
    expect(visibleDrops([{ ...demo, release }], { arena: true }, now)[0].status).toBe('demo');
    for (const evidence of [undefined, { ...release, publishedAt: '2026-10-03T00:00:00Z' }]) {
      expect(visibleDrops([{ ...demo, status: 'live', date: '2026-09-01', release: evidence }], { arena: true }, now)[0].status).toBe('demo');
    }
    expect(visibleDrops([{ ...demo, status: 'live', release }], {}, now)[0].status).toBe('demo');
  });

  it('requires every named feature and binds it to the correct shared Drop stage', () => {
    const record = { ...demo, n: 4, requiredFlags: ['desk_live', 'ask_the_swarm'], status: 'live', release };
    expect(visibleDrops([record], { desk_live: true, ask_the_swarm: false }, now)[0].status).toBe('demo');
    expect(visibleDrops([record], { desk_live: true, ask_the_swarm: true }, now)[0].status).toBe('live');
    for (const requiredFlags of [[], ['approvals'], ['arena', 'arena'], ['unknown']]) {
      expect(visibleDrops([{ ...demo, requiredFlags }], { arena: true }, now)).toEqual([]);
    }
  });

  it('omits undemoed, future recordings and malformed entries while preserving valid demos', () => {
    const invalid = [
      { ...demo, demo: undefined }, { ...demo, demo: { ...demo.demo, recordedAt: '2026-10-03T00:00:00Z' } },
      { ...demo, date: '2026-02-30' }, { ...demo, n: 0 }, { ...demo, title: '' },
      { ...demo, demo: { ...demo.demo, videoUrl: 'https://example.invalid/video.mp4' } },
      { ...demo, release: { ...release, url: 'javascript:alert(1)' } },
    ];
    expect(visibleDrops([...invalid, demo], {}, now)).toEqual([demo]);
    expect(visibleDrops([], { arena: true }, now)).toEqual([]);
  });

  it.each(['/demos/drops/sample-paper.mp4', '/demos/drops/sample-paper.webm'])('allows local video %s', url => {
    expect(DropVideoUrlSchema.safeParse(url).success).toBe(true);
  });
  it.each([
    'https://example.invalid/demos/drops/demo.mp4', '//example.invalid/demo.mp4', 'http://example.invalid/demo.mp4',
    'data:video/mp4;base64,AA', 'blob:https://example.invalid/id', 'javascript:alert(1)',
    '/demos/drops/../demo.mp4', '/demos/drops/%2e%2e/demo.mp4', '/demos/drops/demo%2emp4',
    '/demos/drops/demo.mp4?redirect=https://example.invalid', '/demos/drops/demo.mp4#x',
    '/demos/drops\\demo.mp4', '/demos/drops/demo.svg', '/redirect/demo.mp4', 'demos/drops/demo.mp4',
  ])('rejects video URL %s', url => {
    expect(DropVideoUrlSchema.safeParse(url).success).toBe(false);
  });
});
