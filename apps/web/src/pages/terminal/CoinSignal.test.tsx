import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoinSignalV2Schema, GuardAssessmentV2Schema } from '@eko/shared';
import { guardSamples } from '../../../../../packages/shared/test/fixtures/contracts/guard-v2';
import { CoinSignalPanel } from './CoinSignal';

it('renders neutral V2 risk unavailable in both readings and breakdown', () => {
 const signal = CoinSignalV2Schema.parse(guardSamples.CoinSignalV2);
 const html = renderToStaticMarkup(<CoinSignalPanel signal={signal} guard={GuardAssessmentV2Schema.parse(guardSamples.GuardAssessmentV2)}/>);
 expect(html).toContain('Unavailable');
 expect(html).not.toContain('50 × 10%');
 expect(html).toContain('Guard receipt:'); expect(html).toContain('risk 2.0.0');
 expect(html).toContain('50 only in the numeric calculation');
});

it('overlays the whole cached Signal with current High risk', () => {
 const signal = CoinSignalV2Schema.parse(guardSamples.CoinSignalV2);
 const original = GuardAssessmentV2Schema.parse(guardSamples.GuardAssessmentV2);
 const guard = GuardAssessmentV2Schema.parse({ ...original, observedLevel:'high', level:'high', decisiveIds:['sell_block'] });
 const html = renderToStaticMarkup(<CoinSignalPanel signal={signal} guard={guard}/>);
 expect(html).toContain('High risk · shadow assessment');
 expect(html).toContain('Shadow adapter');
 expect(html).not.toContain('/ 100');
 expect(html).not.toContain('Hot');
});
