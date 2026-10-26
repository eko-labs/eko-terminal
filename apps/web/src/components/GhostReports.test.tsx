import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GhostReportView } from './GhostReports';
import { ghostRecord, ghostSamples } from '../../../../packages/shared/test/fixtures/contracts/ghost-reports';

describe('reviewed Ghost Report surface', () => {
  it('shows snapshot, missing checks, pre-release wording, receipts and full reasons', () => {
    const markup = renderToStaticMarkup(<GhostReportView record={{ ...ghostRecord, review: ghostSamples.GhostReportReview, status: 'reviewed_partial' }} />);
    expect(markup).toContain('partial evidence'); expect(markup).toContain('From our pre-release engine');
    expect(markup).toContain('Not fully checked'); expect(markup).toContain('exit simulation');
    expect(markup).toContain('All reasons, coverage, evidence and corrections');
    expect(markup).toContain('Receipt anchor verification pending');
    expect(markup).toContain('Not financial advice'); expect(markup).toContain('Not affiliated');
    expect(markup).not.toContain('Facts verified');
  });
  it('makes corrections explicit without rewriting the prior snapshot', () => {
    const markup = renderToStaticMarkup(<GhostReportView record={{ ...ghostRecord, review: ghostSamples.GhostReportReview, status: 'correction_needed', assessmentChanged: true, corrections: [ghostRecord.draft.id] }} />);
    expect(markup).toContain('Correction required'); expect(markup).toContain('retains its original snapshot');
    expect(markup).toContain('Correction: /v2/ghost-reports/');
  });
});
