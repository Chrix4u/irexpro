import {
  brandServerM1Signal,
  evaluateM1PrimaryModelDecision,
  hasServerM1Origin,
  isServerPromotedExternalDemoModel,
  PRIMARY_M1_MODEL_IDENTITY,
  isStrictLiveM1PrimarySignal,
} from './server-m1-signal-origin';
import type { AiSignalCandidate } from './interfaces/strategy.interface';

const signal = (changes: Record<string, unknown> = {}): AiSignalCandidate =>
  ({
    userId: 'owner-1',
    signalId: 'signal-1',
    tradingSessionId: 'session-1',
    brokerConnectionId: 'connection-live-1',
    instrument: 'EURUSD',
    direction: 'BUY',
    confidenceScore: 0.75,
    suggestedVolume: 0.01,
    suggestedStopLoss: 1.001,
    suggestedTakeProfit: 1.009,
    timeframe: 'M1',
    strategyCode: 'external-irexpro-multimodel-ensemble',
    modelVersion: 'external-provider/irexpro-multimodel-ensemble-v1/demo-v1',
    generatedAt: new Date(),
    metadata: {
      signal_source: 'EXTERNAL_PROVIDER',
      external_provider_paper_only: true,
      multimodel_plan_b_route: 'CONFIRMED_REVERSAL',
      multimodel_plan_b_paper_admitted: true,
      multimodel_execution_authority_path: 'PRIMARY_PLAN_B',
      m1_tactical_route: 'M1_CONFIRMED_REVERSAL',
      m1_professional_fallback: false,
      m5_early_transition_handoff: false,
      m1_pepperstone_demo_alternative_trial: false,
      extension_exhaustion_demo_scout: false,
    },
    ...changes,
  }) as AiSignalCandidate;

describe('SERVER-owned Pepperstone LIVE M1 primary provenance', () => {
  it('rejects any externally provided JSON candidate even when all fields look valid', () => {
    const fromJson = JSON.parse(JSON.stringify(signal())) as AiSignalCandidate;
    expect(hasServerM1Origin(fromJson)).toBe(false);
    expect(isStrictLiveM1PrimarySignal(fromJson)).toBe(false);
    expect(isStrictLiveM1PrimarySignal(signal())).toBe(false);
  });
  it('brands only an in-process object, never serializable provenance', () => {
    const original = signal();
    brandServerM1Signal(original);
    expect(hasServerM1Origin(original)).toBe(true);
    expect(isStrictLiveM1PrimarySignal(original)).toBe(true);
    expect(isStrictLiveM1PrimarySignal(JSON.parse(JSON.stringify(original)))).toBe(false);
    expect(Object.getOwnPropertySymbols(original)).toHaveLength(1);
    expect(
      Object.getOwnPropertyDescriptor(original, Object.getOwnPropertySymbols(original)[0]!)
        ?.writable,
    ).toBe(false);
  });
  it.each([
    ['TREND_CONTINUATION', 'M1_TREND_CONTINUATION'],
    ['EARLY_TRANSITION', 'M1_EARLY_TRANSITION'],
    ['CONFIRMED_REVERSAL', 'M1_CONFIRMED_REVERSAL'],
  ])(
    'accepts the original primary %s + %s strategy route after server admission',
    (model, route) => {
      const candidate = brandServerM1Signal(
        signal({
          metadata: {
            ...signal().metadata,
            multimodel_plan_b_route: model,
            m1_tactical_route: route,
          },
        }),
      );
      expect(isStrictLiveM1PrimarySignal(candidate)).toBe(true);
    },
  );
  it.each(['M1_EARLY_TRANSITION', 'M1_TREND_CONTINUATION'])(
    'accepts certified LIVE primary reversal semantic timing via %s only with fresh unanimous native votes',
    (route) => {
      const candidate = brandServerM1Signal(
        signal({
          direction: 'SELL',
          metadata: {
            ...signal().metadata,
            multimodel_plan_b_route: 'CONFIRMED_REVERSAL',
            m1_tactical_route: route,
            multimodel_trained_expert_native: true,
            multimodel_trained_expert_direction: 'SELL',
            multimodel_trained_expert_long_votes: 0,
            multimodel_trained_expert_short_votes: 3,
            multimodel_trained_expert_confidence: 0.75,
            multimodel_trained_expert_freshness_seconds: 40,
            multimodel_primary_reversal_timing_bridge: route === 'M1_TREND_CONTINUATION',
          },
        }),
      );
      expect(isStrictLiveM1PrimarySignal(candidate)).toBe(true);
    },
  );
  it('unknown and missing model routes never qualify as matching via undefined values', () => {
    for (const metadata of [
      { ...signal().metadata, multimodel_plan_b_route: 'UNKNOWN', m1_tactical_route: undefined },
      { ...signal().metadata, multimodel_plan_b_route: null, m1_tactical_route: undefined },
      { ...signal().metadata, multimodel_plan_b_route: 'UNKNOWN', m1_tactical_route: 'ABSTAIN' },
    ]) {
      const candidate = brandServerM1Signal(signal({ metadata }));
      expect(isStrictLiveM1PrimarySignal(candidate)).toBe(false);
    }
  });
  it('rejects reversal timing bridges lacking original broker-native proof, fresh expert or bridge verification', () => {
    const proof = {
      ...signal().metadata,
      multimodel_plan_b_route: 'CONFIRMED_REVERSAL',
      m1_tactical_route: 'M1_TREND_CONTINUATION',
      multimodel_trained_expert_native: true,
      multimodel_trained_expert_direction: 'BUY',
      multimodel_trained_expert_long_votes: 3,
      multimodel_trained_expert_short_votes: 0,
      multimodel_trained_expert_confidence: 0.78,
      multimodel_trained_expert_freshness_seconds: 40,
      multimodel_primary_reversal_timing_bridge: true,
    };
    for (const overrides of [
      { multimodel_trained_expert_native: false },
      { multimodel_trained_expert_direction: 'SELL' },
      { multimodel_trained_expert_long_votes: 2 },
      { multimodel_trained_expert_short_votes: 1 },
      { multimodel_trained_expert_confidence: 0.69 },
      { multimodel_trained_expert_freshness_seconds: 121 },
      { multimodel_trained_expert_freshness_seconds: -1 },
      { multimodel_trained_expert_freshness_seconds: null },
      { multimodel_primary_reversal_timing_bridge: false },
      { multimodel_execution_authority_path: 'BLOCKED' },
    ]) {
      const candidate = brandServerM1Signal(signal({ metadata: { ...proof, ...overrides } }));
      expect(isStrictLiveM1PrimarySignal(candidate)).toBe(false);
    }
    // M1 ABSTAIN is never a timing confirmation on LIVE.
    expect(
      isStrictLiveM1PrimarySignal(
        brandServerM1Signal(
          signal({
            metadata: { ...proof, m1_tactical_route: 'ABSTAIN' },
          }),
        ),
      ),
    ).toBe(false);
    // LIVE helper cannot be invoked through external JSON, regardless of proof fields.
    expect(
      isStrictLiveM1PrimarySignal(
        JSON.parse(
          JSON.stringify(
            signal({
              metadata: proof,
            }),
          ),
        ),
      ),
    ).toBe(false);
  });
  it('rejects a demo alternate even when the primary tuple and M1 route match', () => {
    const candidate = signal({
      metadata: { ...signal().metadata, m1_pepperstone_demo_alternative_trial: true },
    });
    brandServerM1Signal(candidate);
    expect(isStrictLiveM1PrimarySignal(candidate)).toBe(false);
  });
  it('rejects disabled Plan-B, nonprimary research paths and changed model identities', () => {
    const variants = [
      { metadata: { ...signal().metadata, multimodel_plan_b_paper_admitted: false } },
      { metadata: { ...signal().metadata, multimodel_execution_authority_path: 'BLOCKED' } },
      { metadata: { ...signal().metadata, m5_early_transition_handoff: true } },
      { metadata: { ...signal().metadata, m1_professional_fallback: true } },
      { metadata: { ...signal().metadata, extension_exhaustion_demo_scout: true } },
      { strategyCode: 'external-caller-pretending-to-be-m1' },
    ];
    for (const fields of variants) {
      const candidate = brandServerM1Signal(signal(fields));
      expect(isStrictLiveM1PrimarySignal(candidate)).toBe(false);
    }
  });
});

describe('account-independent primary-model decision classification', () => {
  it('classifies the same model evidence identically for different account bindings', () => {
    const demo = signal({
      brokerConnectionId: 'demo-account',
      tradingSessionId: 'demo-session',
      suggestedVolume: 7,
    });
    const live = signal({
      brokerConnectionId: 'live-account',
      tradingSessionId: 'live-session',
      suggestedVolume: 0.01,
    });
    expect(evaluateM1PrimaryModelDecision(demo)).toBe('QUALIFIED');
    expect(evaluateM1PrimaryModelDecision(live)).toBe('QUALIFIED');
    expect(isStrictLiveM1PrimarySignal(demo)).toBe(false);
    expect(isStrictLiveM1PrimarySignal(live)).toBe(false);
  });

  it.each([
    [{ multimodel_plan_b_paper_admitted: false }, 'PRIMARY_MODEL_NOT_ADMITTED'],
    [{ m1_professional_fallback: true }, 'EXPERIMENTAL_OR_UNKNOWN_ROUTE'],
    [{ m1_tactical_route: 'ABSTAIN' }, 'M1_TIMING_MISMATCH'],
    [{ m1_tactical_route: 'M1_EARLY_TRANSITION' }, 'NATIVE_EXPERT_PROOF_MISSING'],
  ])('classifies rejected primary evidence without granting authority', (metadata, reason) => {
    const candidate = brandServerM1Signal(
      signal({ metadata: { ...signal().metadata, ...metadata } }),
    );
    expect(evaluateM1PrimaryModelDecision(candidate)).toBe(reason);
    expect(isStrictLiveM1PrimarySignal(candidate)).toBe(false);
  });
});

describe('shared frozen model identity registry', () => {
  it('recognizes the same primary identity without granting execution authority', () => {
    const candidate = signal({ ...PRIMARY_M1_MODEL_IDENTITY });
    expect(isServerPromotedExternalDemoModel(candidate)).toBe(true);
    expect(evaluateM1PrimaryModelDecision(candidate)).toBe('QUALIFIED');
    expect(isStrictLiveM1PrimarySignal(candidate)).toBe(false);
    expect(isStrictLiveM1PrimarySignal(brandServerM1Signal(candidate))).toBe(true);
  });

  it.each(['m1-tactical-v1', 'm1-tactical-v2-m5-lifecycle'])(
    'preserves historical DEMO model identity %s without LIVE promotion',
    (version) => {
      const candidate = brandServerM1Signal(
        signal({
          strategyCode: 'external-irexpro-m1-tactical',
          modelVersion: `external-provider/irexpro-m1-tactical/${version}`,
        }),
      );
      expect(isServerPromotedExternalDemoModel(candidate)).toBe(true);
      expect(evaluateM1PrimaryModelDecision(candidate)).toBe('MODEL_IDENTITY_MISMATCH');
      expect(isStrictLiveM1PrimarySignal(candidate)).toBe(false);
    },
  );

  it('rejects unrecognized versions and timeframes in both existing boundaries', () => {
    for (const fields of [{ modelVersion: 'unknown' }, { timeframe: 'M5' }]) {
      const candidate = brandServerM1Signal(signal(fields));
      expect(isServerPromotedExternalDemoModel(candidate)).toBe(false);
      expect(isStrictLiveM1PrimarySignal(candidate)).toBe(false);
    }
  });
});

describe('offline DEMO route compatibility inventory', () => {
  it.each([
    'DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE',
    'DEMO_ADVISORY_REVERSAL_EARLY_ENTRY_PILOT',
    'DEMO_EXPERT_COUNTER_ENTRY_PILOT',
    'DEMO_ALTERNATIVE_TIMING_TRIAL',
    'HIGH_CONVICTION_RESCUE',
    'M5_EARLY_TRANSITION_HANDOFF',
    'EXTENSION_EXHAUSTION_DEMO_SCOUT',
  ])('distinguishes recognized model identity from unqualified route %s', (route) => {
    const candidate = brandServerM1Signal(
      signal({
        metadata: {
          ...signal().metadata,
          multimodel_execution_authority_path: route,
        },
      }),
    );
    expect(isServerPromotedExternalDemoModel(candidate)).toBe(true);
    expect(evaluateM1PrimaryModelDecision(candidate)).toBe('PRIMARY_MODEL_NOT_ADMITTED');
    expect(isStrictLiveM1PrimarySignal(candidate)).toBe(false);
  });
});
