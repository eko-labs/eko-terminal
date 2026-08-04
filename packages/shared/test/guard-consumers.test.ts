import { describe, expect, it } from 'vitest';
import { compactGuardVerdict, GuardAssessmentV2Schema, GuardConsumerRequestSchema, GuardSignalFieldsSchema, FeedItemSchema, RuleSignalSchema, GUARD_CONSUMER_SURFACES, prepareGuardSurface, guardNotification, guardShareMetadata, guardOgSvg, GUARD_SHARE_TITLE, BUYER_RISK, DYOR, NON_AFFILIATION, formatGuardReason } from '../src/index.js';
import { assessment, guardSamples } from './fixtures/contracts/guard-v2.js';
import v1 from './fixtures/contracts/v1.json';

const guard = GuardAssessmentV2Schema.parse({...assessment,level:'high',observedLevel:'high',baseScore:60,score:60,familyPoints:{E:60,O:0,Ff:0,C:0,I:0},factors:[]});
const request = { version: 2 as const, assessment: guard };
describe('037 compact consumers (synthetic fixtures)', () => {
  it.each(GUARD_CONSUMER_SURFACES)('%s keeps High with gaps or shadow status and all disclosures', surface => {
    const view = prepareGuardSurface({surface,coin:guard.coin,verdict:request});
    expect(view.label).toBe('High risk'); expect(view.mode).toContain('Shadow');
    expect(view.gap).toContain('Not fully checked');
    expect(view.snapshot).toContain('$100 / $1,000');
    for (const text of [BUYER_RISK,DYOR,NON_AFFILIATION]) expect(view.disclosures).toContain(text);
    expect(view.metadata.title).toBe(GUARD_SHARE_TITLE);
  });
  it('limits tiles to three reasons without losing full findings or original receipt', () => {
    const reasons = [1000,100,10000,100].map(sizeUsd => ({...guard.reasons[0],parameters:{...guard.reasons[0].parameters,sizeUsd}}));
    const input = {version:2 as const,assessment:GuardAssessmentV2Schema.parse({...guard,reasons})};
    const view = compactGuardVerdict(input);
    expect(view.lines).toHaveLength(3); expect(view.allReasons).toHaveLength(4);
    expect(view.lines[0]).toBe(formatGuardReason(input.assessment.reasons[1]));
    expect(view.receiptId).toBe(guard.receipt.id);
    expect(view.evidencePath).toBe(`/coin/${guard.coin}#guard-shadow-evidence`);
  });
  it('preserves immutable V1 labels, reasons, legacy matches and receipt bytes', () => {
    const verdict = JSON.parse(JSON.stringify(v1.Verdict)) as typeof v1.Verdict, before = JSON.stringify(verdict);
    const view = compactGuardVerdict(GuardConsumerRequestSchema.parse({version:1,verdict,rulesVersion:'1.0.0'}));
    expect(view.label).toBe('Rule set 1.0.0'); expect(view.level).toBe(verdict.level);
    expect(view.receiptId).toBe(verdict.receipt.id); expect(JSON.stringify(verdict)).toBe(before);
    expect(GuardConsumerRequestSchema.safeParse({version:2,assessment:verdict}).success).toBe(false);
  });
  it('never calls an unavailable assessment Scanning after a record exists', () => {
    const view = compactGuardVerdict({version:2,assessment:null});
    expect(view.level).toBeNull();expect(view.gap).toBe('Coverage unavailable');
    expect(compactGuardVerdict(request).label).not.toContain('Scanning');
  });
  it('rejects untyped factor/reason namespaces and preserves blockedBy and user origin', () => {
    const signal = RuleSignalSchema.parse(guardSamples.RuleSignal);
    expect(signal.blockedBy).toBe('honeypot');expect(signal.source.kind).toBe('rule');
    expect(RuleSignalSchema.safeParse({...signal,source:{...signal.source,kind:'eko'}}).success).toBe(false);
    expect(RuleSignalSchema.safeParse({...signal,status:'passed'}).success).toBe(false);
    expect(GuardSignalFieldsSchema.safeParse({guardFactorId:'serial_deployer'}).success).toBe(false);
    expect(GuardSignalFieldsSchema.safeParse({guardReasonCode:'buy now'}).success).toBe(false);
    expect(FeedItemSchema.parse({...v1.FeedItem,guardFactorId:'execution_cost',guardReasonCode:'EXIT_COST'})).toMatchObject({guardFactorId:'execution_cost',guardReasonCode:'EXIT_COST'});
  });
  it('keeps meta/share neutral and escapes OG markup, controls, bidi and links', () => {
    const symbol = {text:'<script>buy\u202Enow</script>&" https://evil.example',truncated:false,flags:['link' as const]};
    const svg = guardOgSvg(request,symbol);
    expect(svg).not.toContain('<script>');expect(svg).not.toContain('\u202E');expect(svg).not.toContain('href=');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain(NON_AFFILIATION);expect(svg).toContain(DYOR);
    expect(guardShareMetadata(request).title).toBe(GUARD_SHARE_TITLE);
    expect(guardNotification(request)).toContain(BUYER_RISK);
    expect(guardNotification(request)).not.toContain(symbol.text);
    expect(() => prepareGuardSurface({surface:'bot',coin:`0x${'01'.repeat(20)}`,verdict:request})).toThrow('coin mismatch');
    const bad = {...guard,reasons:[{...guard.reasons[0],parameters:{...guard.reasons[0].parameters,snapshotId:'<script>buy</script>'}}]};
    expect(() => guardNotification(GuardConsumerRequestSchema.parse({version:2,assessment:bad}))).toThrow();
  });
});
