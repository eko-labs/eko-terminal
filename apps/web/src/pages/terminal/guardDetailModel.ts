import { guardConsumerReasons, type CoinCardV2, type GuardAssessmentV2, type GuardCoverage, type Metric } from '@eko/shared';
import { GUARD_BUYER_SECTIONS, GUARD_CHECK_LABELS, GUARD_METRIC_NAMES, GUARD_NOT_RUN_REASONS, GUARD_FACTOR_NAMES, guardFactorFineText, formatGuardReason, guardName } from '../../copy/guard';

type SectionId = typeof GUARD_BUYER_SECTIONS[number]['id'];
type Reason = keyof typeof GUARD_NOT_RUN_REASONS;
type Status = 'flagged' | 'fine' | 'checked' | 'pending' | 'not_applicable';
export type GuardDetailRow = {
  id: string; section: SectionId; label: string; text: string; status: Status;
  value: unknown; evidenceIds: string[]; reason?: Reason; priority: number;
};
const checkSections = { reference_exit: 'sell', effective_fees: 'sell', controls_hooks: 'control', supply_float: 'holders', recent_funding: 'holders', coordination_coverage: 'holders', launcher_service: 'maker', operator_history: 'holders' } as const;
const factorSection = (id: string): SectionId => id === 'thin_depth' || id === 'removable_depth' ? 'pool'
  : id === 'agent_instruction' ? 'maker' : id === 'cycling' ? 'flow'
  : /control/.test(id) ? 'control' : /cost|pressure|selling|dump/.test(id) ? 'sell' : 'holders';
const reasonSection = (code: string): SectionId => /CONTROL|EXEMPTIONS/.test(code) ? 'control'
  : /DEPTH/.test(code) ? 'pool' : /CLONE|TEXT/.test(code) ? 'maker' : code === 'CYCLING' ? 'flow'
  : /HELD|HOLDERS|BUYERS|BLOCK|HISTORY/.test(code) ? 'holders' : 'sell';
function pendingReason(code: string | null | undefined, section: SectionId): Reason {
  if (code && code in GUARD_NOT_RUN_REASONS && code !== 'missing') return code as Reason;
  return section === 'sell' ? 'simulation' : section === 'holders' ? 'wallets' : 'missing';
}
const isMetric = (v: object): v is Metric<unknown> => 'unit' in v && 'knownAt' in v && 'status' in v;
const isCoverage = (v: object): v is GuardCoverage => 'scopeId' in v && 'complete' in v;

/** Group recorded results only. Coverage and numeric measurements are not passing findings. */
export function guardDetailModel(card: CoinCardV2 | null, assessment: GuardAssessmentV2 | null = card?.verdict ?? null) {
  const rows: GuardDetailRow[] = [];
  const add = (row: GuardDetailRow) => rows.push(row);
  if (assessment) {
    for (const f of assessment.factors) {
      const section = factorSection(f.id), status = f.state === 'matched' ? 'flagged' : f.state === 'not_matched' ? 'fine' : f.state === 'not_applicable' ? 'not_applicable' : 'pending';
      const reasons = guardConsumerReasons(assessment).filter(r => r.factorId === f.id && r.code !== 'INCOMPLETE' && r.code !== 'POLICY_DENIAL');
      const fallback = { code: f.template, factorId: f.id, parameters: f.parameters, evidenceIds: f.evidenceIds } as Parameters<typeof formatGuardReason>[0];
      for (const [i, r] of (status === 'flagged' && reasons.length ? reasons : [fallback]).entries()) {
        add({ id: `factor.${f.id}.${i}`, section, label: GUARD_FACTOR_NAMES[f.id],
          text: status === 'flagged' ? formatGuardReason(r) : status === 'fine' ? guardFactorFineText(GUARD_FACTOR_NAMES[f.id]) : '',
          status, value: f, evidenceIds: [...new Set([...f.evidenceIds, ...r.evidenceIds])],
          reason: status === 'not_applicable' ? 'not_applicable' : status === 'pending' ? pendingReason(null, section) : undefined,
          priority: f.assignedPoints });
      }
    }
    for (const [i, r] of guardConsumerReasons(assessment).entries()) {
      // Unscored/informational reasons remain in the technical record. Only explicit
      // entry/sell restrictions without a factor are independent flagged results.
      if (r.factorId !== null || (r.code !== 'SELL_RESTRICTION' && r.code !== 'ENTRY_LIMIT')) continue;
      add({ id: `reason.${i}`, section: reasonSection(r.code), label: guardName(r.code), text: formatGuardReason(r), status: 'flagged', value: r, evidenceIds: r.evidenceIds, priority: r.code === 'SELL_RESTRICTION' ? 101 : 100 });
    }
    for (const id of assessment.decisiveIds) {
      add({ id: `decisive.${id}`, section: id === 'liquidity_withdrawn' ? 'pool' : 'sell', label: guardName(id), text: `${guardName(id)}.`, status: 'flagged', value: { decisiveId: id, receipt: assessment.receipt }, evidenceIds: [], priority: 102 });
    }
    for (const c of assessment.checks) {
      const section = checkSections[c.id], status = c.status === 'complete' ? 'checked' : c.status === 'not_applicable' ? 'not_applicable' : 'pending';
      add({ id: `check.${c.id}`, section, label: GUARD_CHECK_LABELS[c.id], text: '', status, value: c, evidenceIds: c.evidenceIds,
        reason: status === 'not_applicable' ? 'not_applicable' : status === 'pending' ? pendingReason(c.failureCode ?? c.status, section) : undefined, priority: 0 });
    }
  }
  function walk(value: unknown, path: string, section: SectionId, name: string, field = ''): void {
    if (value === null || typeof value !== 'object') return;
    if (isMetric(value)) {
      const status: Status = value.status === 'unknown' ? 'pending' : value.status === 'not_applicable' ? 'not_applicable'
        : value.status === 'observed' && (value.value === 'token_restricted' || value.value === 'capacity_absent' || value.value === 'entry_limited') ? 'flagged'
        : value.status === 'observed' && value.value === 'executable' ? 'fine' : 'checked';
      add({ id: path, section, label: name, text: status === 'fine' ? `${name}: executable.` : status === 'flagged' ? `${name}: ${guardName(String(value.value))}.` : '',
        status, value, evidenceIds: value.evidenceIds, reason: status === 'not_applicable' ? 'not_applicable' : status === 'pending' ? pendingReason(value.failureCode, section) : undefined, priority: status === 'flagged' ? 101 : 0 });
      // Compound measurements retain child availability, rather than marking every child checked.
      if (value.value && typeof value.value === 'object') walk(value.value, `${path}.value`, section, name);
      return;
    }
    if (isCoverage(value) || ('text' in value && 'flags' in value) || ('raw' in value && 'asset' in value)) return;
    if (Array.isArray(value)) {
      if (!value.length) {
        const key = field === 'fields' ? 'textFields' : field;
        if (!['pools', 'feeRecipients', 'exemptions', 'hooks', 'existingPositionExits', 'directionalDepth', 'positions', 'rawTop10', 'controlTop10', 'cohorts', 'candidates', 'queuedChanges', 'episodes', 'campaigns', 'outcomes', 'textFields'].includes(key)) return;
        const coverage = card?.collectionCoverage?.[key as keyof NonNullable<CoinCardV2['collectionCoverage']>];
        add({ id: path, section, label: name, text: '', status: coverage?.complete ? 'checked' : 'pending', value: { [field]: value, ...(coverage ? { coverage } : {}) }, evidenceIds: [], reason: coverage?.complete ? undefined : pendingReason(coverage?.gaps[0], section), priority: 0 });
      }
      value.forEach((v, i) => {
        const context = v && typeof v === 'object' && 'sizeUsd' in v && 'accountClass' in v
          ? `$${Number(v.sizeUsd).toLocaleString('en-US')} · ${v.accountClass === 'eoa' ? 'EOA' : 'Smart account'}` : `${name} ${i + 1}`;
        walk(v, `${path}.${i}`, section, context);
      });
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`, section, `${name} · ${GUARD_METRIC_NAMES[key] ?? guardName(key)}`, key);
  }
  if (card) for (const section of GUARD_BUYER_SECTIONS) for (const group of section.groups) walk(card[group], group, section.id, '', group);
  // Remove the initial separator without altering the technical path or context.
  for (const row of rows) { row.label = row.label.replace(/^ · /, ''); row.text = row.text.replace(/^ · /, ''); }
  const flagged = rows.filter(r => r.status === 'flagged').sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  const fine = rows.filter(r => r.status === 'fine');
  const pending = rows.filter(r => r.status === 'pending');
  const excluded = rows.filter(r => r.status === 'not_applicable');
  const notRun = Object.entries(GUARD_NOT_RUN_REASONS).map(([reason, title]) => ({ reason, title, rows: rows.filter(r => r.reason === reason) })).filter(g => g.rows.length);
  const sections = GUARD_BUYER_SECTIONS.map(s => {
    const all = rows.filter(r => r.section === s.id);
    return { ...s, rows: all.filter(r => r.status !== 'pending' && r.status !== 'not_applicable'),
      fine: all.filter(r => r.status === 'fine').length, flagged: all.filter(r => r.status === 'flagged').length,
      pending: all.filter(r => r.status === 'pending').length, measured: all.filter(r => r.status === 'checked').length,
      excluded: all.filter(r => r.status === 'not_applicable').length };
  }).filter(s => s.rows.length);
  return { flagged, fine, pending, excluded, notRun, sections, technical: { card, assessment } };
}
