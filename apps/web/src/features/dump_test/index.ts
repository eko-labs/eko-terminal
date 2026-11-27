import { lazy } from 'react';
import type { Feature } from '../../features';
import { fallOf, summaryOf } from './model';

/**
 * Dump test (flag `dump_test`): what a coin's price would do if its insiders sold everything they hold right now, in
 * one line: "If insiders dump: −83% · your $100 → $17". A glance tile right after the verdict (order 5, first among the
 * stats), a section at the top of the Overview tab with each insider group, a key fact on Simple's coin page, and a
 * figure in every coin list row (Radar's column and Simple's rows, from RadarRow.extras.dump_test), sortable.
 * In-site alerts ("Dump risk rose") come from the edge.
 */
const view = () => import('./DumpTest');
const feature: Feature = {
  coin: {
    glance: { order: 5, component: lazy(() => view().then(m => ({ default: m.DumpGlance }))) },
    section: { tab: 'Overview', id: 'dump-test', title: 'If insiders dump', order: -10, component: lazy(() => view().then(m => ({ default: m.DumpSection }))) },
    fact: { order: 0, component: lazy(() => view().then(m => ({ default: m.DumpFact }))) },
  },
  places: {
    coinRow: {
      id: 'dump', label: 'Dump', title: 'If insiders dump: how far EKO estimates the price would fall if they sold everything at once',
      value: row => { const s = summaryOf(row); return s ? fallOf(s.changePct) : undefined; },
      cell: lazy(() => view().then(m => ({ default: m.DumpCell }))),
    },
  },
  // Example data for mock mode only (demos and update films): never loaded on the live site.
  demo: () => import('./demo'),
};
export default feature;
