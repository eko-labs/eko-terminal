import { Bytes32Schema, ReviewRoleSchema, ReviewViewSchema, ReviewLabelSchema, ReviewAdjudicationSchema, ReviewExportSchema, type ReviewRole, type ReviewLabelInput, type ReviewAdjudicationInput } from '@eko/shared';
import { fetchParsed } from '../../lib/api';
export function createReviewClient(parse = fetchParsed) {
  const root = (id: string) => `/v2/review/revisions/${Bytes32Schema.parse(id)}`;
  return {
    async load(id: string, signal?: AbortSignal) {
      const [view, role] = await Promise.all([parse(root(id), ReviewViewSchema, { signal }), parse(`${root(id)}/role`, ReviewRoleSchema, { signal })]);
      if (view.case.id !== id) throw new Error('Review revision mismatch');
      return { view, role };
    },
    async submit(id: string, role: ReviewRole, body: ReviewLabelInput | ReviewAdjudicationInput) {
      if (role === 'evaluator') throw new Error('Evaluator is read-only');
      if (role === 'adjudicator') await parse(`${root(id)}/adjudications`, ReviewAdjudicationSchema, { body });
      else await parse(`${root(id)}/labels`, ReviewLabelSchema, { body });
      // Only the server projection can grant reveal, including after unresolved submission.
      return this.load(id);
    },
    async export(caseId: string) {
      const data = await parse(`/v2/review/cases/${Bytes32Schema.parse(caseId)}/export`, ReviewExportSchema);
      if (data.caseId !== caseId) throw new Error('Review export mismatch');
      return data;
    },
  };
}
export const reviewClient = createReviewClient();
