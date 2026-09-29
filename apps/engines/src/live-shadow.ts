import { z } from 'zod';
import { referenceDigest } from '@eko/chain';
import { AddressSchema, Bytes32Schema, GuardScoreInputSchema, VerdictSchema, CoinSignalSchema } from '@eko/shared';
import { evaluateGuardV2 } from '@eko/playbooks';
import { computeSignalV2 } from '@eko/signal';
import { developmentGrid, projectDevelopmentScore } from './development-fit.js';
import { DevelopmentFreezeSchema } from './locked-test.js';

export const LIVE_SHADOW_VERSION = 'live-shadow-062.1' as const;
const sec = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const code = z.string().regex(/^[a-z0-9_:-]+$/).max(120);
const latency = z.number().finite().nonnegative().nullable();
const horizon = z.union([z.literal(300), z.literal(3600), z.literal(86400), z.literal(604800)]);
const gate = z.strictObject({ gate: code, acceptancePass: z.literal(false), numericalPass: z.boolean() });
// TODO(spec): §9.4 does not define a runner/checkpoint wire format. Keep this
// fixture-only envelope local to engines; it cannot attest measured acceptance.
export const LiveShadowDefinitionSchema = z.strictObject({
  version: z.literal(LIVE_SHADOW_VERSION), origin: z.literal('fixture'), startSec: sec,
  sourceRevision: Bytes32Schema, datasetHash: Bytes32Schema, labelSetHash: Bytes32Schema,
  configHashes: z.array(Bytes32Schema).min(1), freeze: DevelopmentFreezeSchema.nullable(),
  lockedEvaluation: z.strictObject({ reportHash: Bytes32Schema, acceptedCandidate: z.null(),
    origin: z.literal('fixture'), gateTable: z.array(gate).min(1) }),
  entryDelaySec: z.literal(60), requiredHorizonsSec: z.array(horizon).min(1), confirmationSec: sec,
  budget: z.strictObject({ capNanoUsd: z.string().regex(/^(0|[1-9]\d*)$/),
    pricingEvidence: Bytes32Schema.nullable() }),
});
const launch = z.strictObject({ coin: AddressSchema, launchSec: sec });
const snapshot = z.strictObject({ coin: AddressSchema, input: GuardScoreInputSchema,
  legacyVerdict: VerdictSchema, legacySignal: CoinSignalSchema.nullable(),
  legacyPolicyDenials: z.strictObject({ safe: z.boolean(), balanced: z.boolean(), degen: z.boolean() }),
  venue: code, ageSec: sec,
  latency: z.strictObject({ scanMs: latency, enrichmentMs: latency, probeMs: latency, attributionMs: latency,
    alertMs: latency, criticalCompletionMs: latency, lowerCompletionMs: latency, preflightMs: latency }),
  source: z.strictObject({ sourceId: code, complete: z.boolean(), gaps: z.array(code) }),
  serviceBotErrors: z.array(code),
});
const followup = z.strictObject({ coin: AddressSchema, horizonSec: horizon, coveredThroughSec: sec,
  confirmedThroughSec: sec, outcome: z.enum(['known', 'provider_censored', 'missing']), evidenceHash: Bytes32Schema });
export const LiveShadowTickSchema = z.strictObject({ throughSec: sec,
  // Half-open, successfully enumerated source intervals; missing time earns no credit.
  coverage: z.array(z.strictObject({ fromSec: sec, throughSec: sec, sourceHash: Bytes32Schema })),
  launches: z.array(launch), snapshots: z.array(snapshot), followup: z.array(followup),
  gateChecks: z.array(z.strictObject({ gate: code, passed: z.boolean(), evidenceHash: Bytes32Schema })),
  requestUnits: z.literal(0), requests: z.literal(0), paidNanoUsd: z.literal('0'),
});
export const LiveShadowInputSchema = z.strictObject({ definition: LiveShadowDefinitionSchema,
  ticks: z.array(LiveShadowTickSchema).max(10000) });
export type LiveShadowInput = z.infer<typeof LiveShadowInputSchema>;
const modes = ['safe', 'balanced', 'degen'] as const;
const metrics = ['scanMs', 'enrichmentMs', 'probeMs', 'attributionMs', 'alertMs',
  'criticalCompletionMs', 'lowerCompletionMs', 'preflightMs'] as const;
const percentile = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return { observations: values.length, completed: known.length, missing: values.length - known.length,
    p95Ms: known.length ? known[Math.ceil(known.length * .95) - 1] : null };
};

/** Captured, offline shadow only. No acquisition, database, API, policy writer,
 * signing, activation or background scheduling capability is accepted here. */
export function reportLiveShadowFixtures(raw: LiveShadowInput, implementationRevision: string) {
  const input = LiveShadowInputSchema.parse(raw), d = input.definition;
  Bytes32Schema.parse(implementationRevision);
  if (!d.requiredHorizonsSec.includes(3600) || new Set(d.requiredHorizonsSec).size !== d.requiredHorizonsSec.length)
    throw new Error('Unique horizons including the primary 3600 seconds required');
  if (new Set(d.configHashes).size !== d.configHashes.length || new Set(d.lockedEvaluation.gateTable.map(g => g.gate)).size !== d.lockedEvaluation.gateTable.length)
    throw new Error('Duplicate frozen configuration/gates');
  const freeze = d.freeze;
  if (freeze) {
    const { freezeHash, ...body } = freeze;
    if (referenceDigest(body) !== freezeHash || !freeze.parameters || freeze.status !== 'development_frozen_awaiting_untouched_test' ||
        freeze.parametersHash !== freeze.parameters.parametersHash ||
        !developmentGrid().some(p => referenceDigest(p) === referenceDigest(freeze.parameters)))
      throw new Error('Ineligible or changed fixture freeze');
  }
  let through = d.startSec, enrollmentEndSec: number | null = null;
  const launches = new Map<string, z.infer<typeof launch>>();
  const intervals: { fromSec: number; throughSec: number }[] = [];
  const followups = new Map<string, z.infer<typeof followup>>();
  const seenSnapshots = new Set<string>(), rows: ReturnType<typeof compareSnapshot>[] = [];
  const regressions = new Set<string>();
  const coveredSeconds = () => {
    const end = enrollmentEndSec ?? through;
    const sorted = intervals.map(r => ({ fromSec: Math.max(r.fromSec, d.startSec), throughSec: Math.min(r.throughSec, end) }))
      .filter(r => r.throughSec > r.fromSec).sort((a, b) => a.fromSec - b.fromSec);
    let total = 0, last = d.startSec;
    for (const r of sorted) { total += Math.max(0, r.throughSec - Math.max(last, r.fromSec)); last = Math.max(last, r.throughSec); }
    return total;
  };
  function compareSnapshot(s: z.infer<typeof snapshot>) {
    if (!freeze?.parameters) throw new Error('No frozen fixture parameters');
    if (s.input.mode !== 'shadow' || s.input.shadowBooster || s.input.coin !== s.coin || s.legacyVerdict.coin !== s.coin || s.legacyVerdict.guardV2)
      throw new Error('Shadow isolation/context mismatch');
    if (s.legacyVerdict.asOfBlock !== Number(s.input.cursor.blockNumber) || s.input.codeHash !== freeze?.candidateRevision ||
        s.input.calibrationManifestHash !== freeze.calibrationHash) throw new Error('Frozen snapshot revision/context mismatch');
    const base = evaluateGuardV2(s.input), prediction = projectDevelopmentScore(s.input, freeze.parameters!, 'baseline', base);
    // Shared assessment contracts fix 30/60 and base weights. Do not forge a
    // schema-valid receipt for other frozen parameters or promote their bands.
    const compatible = prediction.level === base.assessment.level && prediction.score === base.assessment.score &&
      prediction.assignedFactors.every(f => f.assignedPoints === base.assessment.factors.find(b => b.id === f.id)?.assignedPoints);
    const signal = compatible ? computeSignalV2({ guard: base.assessment, powers: [], lpStatus: null,
      ...(s.legacySignal ? { legacySignal: s.legacySignal } : {}) }) : null;
    const proxy = { safe: prediction.level !== 'lower' || !prediction.complete,
      balanced: ['high', 'incomplete'].includes(prediction.level), degen: ['high', 'incomplete'].includes(prediction.level) };
    const legacyLevel = { clear: 'lower', monitor: 'elevated', danger: 'high', pending: 'incomplete' }[s.legacyVerdict.level];
    return { coin: s.coin, cursor: s.input.cursor, candidate: prediction,
      apiPreview: { mode: 'shadow', activeBadge: false, level: prediction.level, gaps: prediction.missing },
      // Buyer-level diagnostic only; actual-size cost/kill/access/full preflight remain separate.
      policy: { scope: 'buyer_level_proxy', candidateDenials: proxy, legacyDenials: s.legacyPolicyDenials,
        disagreements: modes.filter(m => proxy[m] !== s.legacyPolicyDenials[m]), applied: false },
      guardDisagreement: prediction.level !== legacyLevel, signal,
      signalGap: compatible ? null : 'frozen_parameters_not_supported_by_shared_signal_contract',
      signalDisagreement: signal && s.legacySignal ? signal.readings.risk !== s.legacySignal.readings.risk : null,
      venue: s.venue, ageSec: s.ageSec, latency: s.latency, source: s.source, serviceBotErrors: s.serviceBotErrors,
      legacyVerdictHash: referenceDigest(s.legacyVerdict), legacySignalHash: referenceDigest(s.legacySignal) };
  }
  for (const tick of input.ticks) {
    if (tick.throughSec <= through) throw new Error('Non-progressing source clock');
    const previousThrough = through; through = tick.throughSec;
    for (const r of tick.coverage) {
      if (r.fromSec < previousThrough || r.throughSec > through || r.fromSec >= r.throughSec) throw new Error('Invalid coverage interval');
      intervals.push(r);
    }
    for (const l of tick.launches) {
      if (enrollmentEndSec !== null || l.launchSec < previousThrough || l.launchSec >= through || launches.has(l.coin))
        throw new Error('Duplicate or out-of-window launch');
      if (!intervals.some(r => r.fromSec <= l.launchSec && l.launchSec < r.throughSec)) throw new Error('Launch outside enumerated coverage');
      launches.set(l.coin, l);
    }
    for (const s of tick.snapshots) {
      const l = launches.get(s.coin), at = Number(s.input.cursor.timestampSec), id = referenceDigest({ coin: s.coin, cursor: s.input.cursor });
      if (!freeze || !l || at < l.launchSec || at > through || s.ageSec !== at - l.launchSec || seenSnapshots.has(id))
        throw new Error('Snapshot unavailable, duplicated or outside launch clock');
      seenSnapshots.add(id); rows.push(compareSnapshot(s));
    }
    for (const f of tick.followup) {
      const key = `${f.coin}:${f.horizonSec}`, prior = followups.get(key), l = launches.get(f.coin);
      if (!l || !d.requiredHorizonsSec.includes(f.horizonSec) || f.coveredThroughSec > through || f.confirmedThroughSec > through ||
          f.confirmedThroughSec > f.coveredThroughSec || f.coveredThroughSec < l.launchSec ||
          prior && (f.coveredThroughSec < prior.coveredThroughSec || f.confirmedThroughSec < prior.confirmedThroughSec))
        throw new Error('Follow-up clock/context regression');
      followups.set(key, f);
    }
    for (const g of tick.gateChecks) if (!g.passed) regressions.add(g.gate);
    if (enrollmentEndSec === null && coveredSeconds() >= 604800 && launches.size >= 5000) enrollmentEndSec = through;
  }
  const entrants = [...launches.values()].map(l => {
    const horizons = d.requiredHorizonsSec.map(h => {
      const f = followups.get(`${l.coin}:${h}`), dueSec = l.launchSec + d.entryDelaySec + h + d.confirmationSec;
      if (!Number.isSafeInteger(dueSec)) throw new Error('Maturity clock overflow');
      return { horizonSec: h, dueSec, outcome: f?.outcome ?? 'missing', evidenceHash: f?.evidenceHash ?? null,
        mature: through >= dueSec && !!f && f.coveredThroughSec >= dueSec && f.confirmedThroughSec >= dueSec,
        known: f?.outcome === 'known' };
    });
    return { ...l, horizons, mature: horizons.every(h => h.mature), known: horizons.every(h => h.mature && h.known) };
  });
  const coveredDurationSec = coveredSeconds(), mature = entrants.filter(l => l.mature).length;
  const fixtureProgress = !freeze ? 'disabled_no_accepted_candidate' : enrollmentEndSec === null ? 'fixture_collecting'
    : mature < launches.size ? 'fixture_followup' : 'fixture_complete';
  const latencyReport = [...new Set(rows.map(r => `${r.venue}:${r.ageSec}`))].sort().map(slice => {
    const selected = rows.filter(r => `${r.venue}:${r.ageSec}` === slice);
    return { slice, metrics: Object.fromEntries(metrics.map(m => [m, percentile(selected.map(r => r.latency[m]))])) };
  });
  const preflight = percentile(rows.map(r => r.latency.preflightMs));
  const diagnostics = [
    { gate: 'live_duration', numericalPass: coveredDurationSec >= 604800 },
    { gate: 'live_launches', numericalPass: launches.size >= 5000 },
    { gate: 'final_entrant_maturity', numericalPass: launches.size > 0 && mature === launches.size },
    { gate: 'followup_outcomes', numericalPass: entrants.length > 0 && entrants.every(l => l.known) },
    { gate: 'shadow_coverage', numericalPass: entrants.length > 0 && entrants.every(l => rows.some(r => r.coin === l.coin)) &&
      rows.every(r => r.source.complete && r.source.gaps.length === 0) },
    { gate: 'signal_contract', numericalPass: rows.length > 0 && rows.every(r => r.signalGap === null) },
    { gate: 'preflight_latency', numericalPass: preflight.missing === 0 && preflight.p95Ms !== null && preflight.p95Ms < 150 },
    { gate: 'service_bot_errors', numericalPass: rows.length > 0 && rows.every(r => r.serviceBotErrors.length === 0) },
    { gate: 'no_gate_regressions', numericalPass: regressions.size === 0 },
  ];
  const report = { version: LIVE_SHADOW_VERSION, origin: 'fixture', status: fixtureProgress,
    disabledReason: 'no accepted frozen candidate; fixtures cannot authorize live shadow',
    enabled: false, acceptedCandidate: null, active: false, released: false, mode: 'shadow', releaseManifest: null,
    lowerEnabled: false, historyEnabled: false, bucketsEnabled: false,
    pins: { implementationRevision, definitionHash: referenceDigest(d), inputHash: referenceDigest(input),
      sourceRevision: d.sourceRevision, datasetHash: d.datasetHash, labelSetHash: d.labelSetHash, configHashes: d.configHashes,
      freezeHash: freeze?.freezeHash ?? null, candidateRevision: freeze?.candidateRevision ?? null,
      parametersHash: freeze?.parametersHash ?? null, lockedReportHash: d.lockedEvaluation.reportHash },
    measured: { coveredDurationSec: 0, launches: 0, matureLaunches: 0 },
    fixture: { startSec: d.startSec, throughSec: through, wallElapsedSec: through - d.startSec, coveredDurationSec,
      minimumDurationSec: 604800, minimumLaunches: 5000, launches: launches.size, enrollmentEndSec,
      matureLaunches: mature, pendingLaunches: launches.size - mature, knownLaunches: entrants.filter(l => l.known).length,
      entryDelaySec: d.entryDelaySec, requiredHorizonsSec: d.requiredHorizonsSec, confirmationSec: d.confirmationSec, entrants },
    coverage: { snapshots: rows.length, unassessedLaunches: entrants.filter(l => !rows.some(r => r.coin === l.coin)).length,
      incompleteSnapshots: rows.filter(r => !r.candidate.complete).length, sources: rows.map(r => r.source) },
    comparisons: rows, operations: { latency: latencyReport, serviceBotErrors: rows.flatMap(r => r.serviceBotErrors),
      preflight, evaluatorRpcCalls: 0, preflightIsProxy: true, pilotTargetsAccepted: false },
    diagnostics,
    gateTable: [...d.lockedEvaluation.gateTable, { gate: 'live_shadow', numericalPass: !!freeze && enrollmentEndSec !== null &&
      diagnostics.every(g => g.numericalPass),
      acceptancePass: false as const }], gateRegressions: [...regressions].sort(),
    spend: { actualRequests: 0, actualRequestUnits: 0, actualPaidNanoUsd: '0', pricingEvidence: d.budget.pricingEvidence,
      capNanoUsd: d.budget.capNanoUsd, budgetAccepted: false },
    process: { running: false, continuationInstalled: false,
      nextAction: 'obtain_accepted_frozen_candidate_and_measured_runner_before_starting_live_shadow' },
  };
  return { ...report, reportHash: referenceDigest(report) };
}
