import type { ResearchJob } from '@eko/shared';
import { Link } from '../../lib/Link';
import { MOCKS } from '../../lib/api';
import { UntrustedText } from '../../components/ui';
import { createResearchNotes } from '../../mocks/demo/research';
import { AnalysisPolicyNotice } from '../../components/PolicyLinks';
import { CompactVerdictChip } from '../../components/GuardCompact';

export function ResearchNotes({ notes }: { notes: ResearchJob[] | null }) {
  return <div className="shell-page">
    <div className="page-head"><span className="eyebrow">Mission Control</span><h1>Research</h1><p>Your Deep Research notes.</p></div>
    <AnalysisPolicyNotice />
    {notes === null ? <p className="shell-note">The notes list is pending its data service.</p>
      : notes.length === 0 ? <p>No research notes yet.</p>
      : <ul className="research-notes">{notes.map((job) => <li key={job.id}>
        <Link to={`/research/${encodeURIComponent(job.id)}`} className="inspector-row">
          <span>{job.note ? <UntrustedText value={job.note.summary} /> : job.id}</span>
          {job.note && <CompactVerdictChip linked={false} level={job.note.level} guard={job.note.guardV2} />}
        </Link>
      </li>)}</ul>}
  </div>;
}
export default function Research() {
  // TODO(spec): §2.2 adds the notes list, but FACTS §7 defines only POST /research
  // and GET /research/:id. Wire the authenticated list when its API contract is specified.
  return <ResearchNotes notes={MOCKS ? createResearchNotes() : null} />;
}
