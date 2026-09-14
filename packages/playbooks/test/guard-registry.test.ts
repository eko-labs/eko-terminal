import { describe, expect, it } from 'vitest';
import { keccak256, stringToHex } from 'viem';
import { canonicalize } from '@eko/policy';
import { GUARD_CHECK_IDS, GUARD_CHECK_TIERS, GUARD_FACTOR_IDS, GUARD_FACTOR_FAMILIES, GUARD_DECISIVE_IDS } from '@eko/shared';
import { CONFIG_GUARD_V2, GUARD_PARAMETERS, GUARD_FACTORS, GUARD_CHECKS, GUARD_DECISIVE, GUARD_RELEASE_GATES, GUARD_COMPATIBILITY, GUARD_PARAMETERS_HASH, GUARD_CANDIDATE_VERSION, GUARD_SOURCE_REVISION, RULES_VERSION, CONFIG_HASH, CONFIG_V1 } from '../src/index.js';

const parameter = (id: string) => { const p = GUARD_PARAMETERS.find((p) => p.id === id); expect(p, id).toBeDefined(); return p!; };
describe('Guard 2.0 candidate registry (§§5/9.4), not released scoring', () => {
  it('leaves the active 1.0.2 rules/hash untouched and hashes an immutable separate manifest', () => {
    expect(RULES_VERSION).toBe('1.0.2');
    expect(CONFIG_HASH).toBe(keccak256(stringToHex(canonicalize(CONFIG_V1))));
    expect(GUARD_CANDIDATE_VERSION).toBe('2.0.0');
    expect(GUARD_SOURCE_REVISION).toBe('guard-2.0/2026-10-02');
    expect(CONFIG_GUARD_V2.mode).toBe('shadow');
    expect(CONFIG_GUARD_V2.lowerEnabled).toBe(false);
    expect(CONFIG_GUARD_V2.boosterEnabled).toBe(false);
    expect(GUARD_PARAMETERS_HASH).toBe(keccak256(stringToHex(canonicalize(CONFIG_GUARD_V2))));
    const assertFrozen = (value: unknown): void => { if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); for (const child of Object.values(value)) assertFrozen(child); } };
    assertFrozen(CONFIG_GUARD_V2);
  });
  it('registers every closed factor, decisive condition and both required tiers', () => {
    expect(GUARD_FACTORS.map((f) => f.id)).toEqual(GUARD_FACTOR_IDS);
    for (const f of GUARD_FACTORS) {
      expect(f.family).toBe(GUARD_FACTOR_FAMILIES[f.id]);
      expect(f.status).toBe('shadow'); expect(f.acceptanceArtifact).toBeNull();
      expect(f.parameter.id).toBe(`factor.${f.id}`);
      expect(f.parameter.fitGrid).toEqual({ weights: 'base and +/-20%, nearest integer half upward' });
      expect(f.gate).toContain('factor_promotion');
    }
    expect(GUARD_CHECKS.map((c) => c.id)).toEqual(GUARD_CHECK_IDS);
    expect(GUARD_CHECKS.filter((c) => c.tier === 'buy_critical').length).toBe(4);
    expect(GUARD_CHECKS.filter((c) => c.tier === 'lower_tier').length).toBe(4);
    for (const c of GUARD_CHECKS) { expect(c.tier).toBe(GUARD_CHECK_TIERS[c.id]); expect(c.completion.length).toBeGreaterThan(40); expect(c.acceptanceArtifact).toBeNull(); }
    expect(GUARD_DECISIVE.map((d) => d.id)).toEqual(GUARD_DECISIVE_IDS);
    expect(GUARD_RELEASE_GATES.every((g) => g.status === 'unpassed' && g.artifact === null)).toBe(true);
  });
  it('has a source, starting value/formula, exact comparison, rationale, method, truth and gate for every CALIBRATE group', () => {
    const expectedIds = [
      'level_bands', 'buyer_horizon', 'preset_depth', 'preset_cost', 'service_candidate', 'hub_screen', 'recent_funder', 'collector', 'closed_loop', 'bounded_paths', 'medium_path', 'consolidation', 'group_minimum', 'launch_bundle_window', 'broad_distribution', 'early_windows', 'persistent_sniper', 'supply_convention', 'stable_float', 'usd_quality', 'position_accounting', 'cash_multiples', 'cash_severity_context', 'sale_episodes', 'mechanical_pressure', 'reserve_origin', 'depth_solver', 'two_account_confirmation', 'confiscation', 'control_horizon', 'hook_diagnostics', 'cycling', 'curve_recycling', 'trend_context', 'instruction_predicate', 'card_context', 'flow_accounting', 'confirmation_lag', 'harm_materiality', 'harm_cohorts', 'withdrawal_label', 'collapse_label', 'family_allocation', 'history_booster', 'candidate_coverage', 'signal_adapter', 'free_limiter', 'incremental_caps', 'calibration_frame', 'throughput', 'benchmark_trajectories', 'severely_hurt', 'sample_design', 'parity_workload', 'bootstrap', 'high_gate', 'recall_gate', 'lower_gate', 'attribution_gate', 'restriction_gate', 'instruction_gate', 'measurement_gate', 'parity_gate', 'live_shadow_gate', 'maintenance_sample',
    ];
    expect(GUARD_PARAMETERS.map((p) => p.id)).toEqual(expectedIds);
    const gates = new Set(GUARD_RELEASE_GATES.map((g) => g.id));
    for (const p of [...GUARD_PARAMETERS, ...GUARD_FACTORS.map((f) => f.parameter)]) {
      expect(p.value !== null || p.formula !== null, p.id).toBe(true);
      for (const field of ['unit', 'operator', 'reason', 'source', 'method', 'truth'] as const) expect(p[field].length, `${p.id}.${field}`).toBeGreaterThan(0);
      expect(p.methodVersion).toBe('2.0.0'); expect(p.status).toBe('shadow'); expect(p.acceptanceArtifact).toBeNull();
      expect(p.gate.every((g) => gates.has(g))).toBe(true);
    }
  });
  it('pins boundary inclusivity and corrected source adaptations, without vendor score import', () => {
    const byId = Object.fromEntries(GUARD_FACTORS.map((f) => [f.id, f]));
    expect(byId.execution_cost.cuts).toEqual([5, 10, 25, 50]); expect(byId.execution_cost.points).toEqual([10, 20, 40, 60]);
    expect(byId.thin_depth.operator).toBe('<'); expect(byId.thin_depth.cuts).toEqual([10000, 2000, 500]);
    expect(byId.top10_float.operator).toBe('>='); expect(byId.top10_float.cuts).toEqual([40, 60, 80]);
    expect(byId.current_sell_pressure.cuts).toEqual([[5, 10], [15, 30]]);
    expect(byId.mutable_control.cuts).toEqual([[5, 30], [5, 20]]);
    expect(parameter('collector').source).toContain('not Factories DP2');
    expect(parameter('withdrawal_label').source).toContain('Cernera/Huynh');
    expect(parameter('cash_multiples').source).toContain('not GMGN accounting');
    expect(parameter('persistent_sniper').operator).toContain('early buys / all buys');
    expect(parameter('mechanical_pressure').value).toBe(36);
    expect(parameter('depth_solver').value).toEqual([1, 1000000, 1, 48]);
    expect(parameter('level_bands').fitGrid).toEqual({ lower: [25, 30, 35], high: [55, 60, 65] });
    expect(parameter('sample_design').formula).toContain('n_h/N_h');
    expect(parameter('high_gate').operator).toContain('per primary size/class');
    expect(parameter('live_shadow_gate').operator).toContain('AND');
    expect(GUARD_COMPATIBILITY.default).toBe('compatible'); expect(GUARD_COMPATIBILITY.proofRequired).toBe(true);
    expect(parameter('family_allocation').reason).toContain('M E40/Ff40 plus N E20 must total60');
  });
});
