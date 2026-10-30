import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResearchJobSchema } from '@eko/shared';
import { ResearchNotes } from './Research';
import { createResearchNotes } from '../../mocks/demo/research';
import { resolveRoute } from '../../routes';
import { NAV_GROUPS } from '../../components/shell/navigation';

describe('D0 Research notes', () => {
  it('uses the exact flag and SIWE gate for the list and note routes', () => {
    expect(NAV_GROUPS[1][1].find(([, label]) => label === 'Research')?.[0]).toBe('/research');
    for (const path of ['/research', '/research/research-1']) {
      expect(resolveRoute(path)).toBeNull();
      expect(resolveRoute(path, { deep_research: false })).toBeNull();
      expect(resolveRoute(path, { deep_research: true })?.route).toMatchObject({ flag: 'deep_research', stage: 'D0', auth: 'siwe' });
    }
  });
  it('renders two validated sample notes linking to their detail URLs', () => {
    const notes = createResearchNotes();
    expect(notes).toHaveLength(2);
    for (const note of notes) expect(ResearchJobSchema.parse(note)).toEqual(note);
    const html = renderToStaticMarkup(<ResearchNotes notes={notes} />);
    expect(html).toContain('href="/research/research-1"');
    expect(html).toContain('href="/research/research-2"');
    expect(html).not.toContain('/research/new');
    expect(html).toContain('Deployer and liquidity observations');
    expect(html).toContain('Holder distribution and agent inflow');
  });
  it('distinguishes an empty list from an unavailable service', () => {
    expect(renderToStaticMarkup(<ResearchNotes notes={[]} />)).toContain('No research notes yet.');
    expect(renderToStaticMarkup(<ResearchNotes notes={null} />)).toContain('pending its data service');
  });
});
