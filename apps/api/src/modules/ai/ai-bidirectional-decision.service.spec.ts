import { DataSource } from 'typeorm';
import { AiBidirectionalDecisionService } from './ai-bidirectional-decision.service';

describe('AiBidirectionalDecisionService', () => {
  it('pairs BUY and SELL from the same market bar and exposes only curated governance evidence', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { model_version: 'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v1' },
      ])
      .mockResolvedValueOnce([
        {
          model_version: 'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v1',
          instrument: 'EURUSD',
          direction: 'BUY',
          market_bar_time: '2026-10-08T08:35:00.000Z',
          evaluated_at: '2026-10-08T08:35:10.000Z',
          confidence: '0.67',
          meta_probability: '0.49',
          expected_r: '0.31',
          regime: 'TREND_HEALTHY',
          consensus_passed: 6,
          consensus_required: 6,
          reasons: ['ADMIT'],
          components: {
            strategyRoute: 'TREND_CONTINUATION',
            paperAdmitted: true,
            stopLoss: 1.1,
            takeProfit: 1.2,
            governance: {
              netExpectedR: 0.24,
              driftState: 'NORMAL',
              paperExecutionEligible: true,
              paperExecutionBlockers: [],
              executionSpreadEvidence: { spreadPrice: 0.00001 },
            },
          },
        },
        {
          model_version: 'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v1',
          instrument: 'EURUSD',
          direction: 'SELL',
          market_bar_time: '2026-10-08T08:35:00.000Z',
          evaluated_at: '2026-10-08T08:35:11.000Z',
          confidence: '0.61',
          meta_probability: '0.35',
          expected_r: '-0.06',
          regime: 'TREND_WEAK',
          consensus_passed: 3,
          consensus_required: 6,
          reasons: ['REGIME_TREND_WEAK', 'CONFIDENCE_FLOOR'],
          components: {
            strategyRoute: 'TREND_CONTINUATION',
            paperAdmitted: false,
            stopLoss: 1.2,
            takeProfit: 1.1,
            governance: {
              netExpectedR: -0.11,
              driftState: 'OUT_OF_DISTRIBUTION',
              paperExecutionEligible: false,
              paperExecutionBlockers: [
                'ENSEMBLE_NOT_PAPER_ADMITTED',
                'PAPER_NET_EXPECTED_R',
                'DRIFT_OUT_OF_DISTRIBUTION',
              ],
            },
          },
        },
      ]);
    const service = new AiBidirectionalDecisionService({ query } as unknown as DataSource);

    const result = await service.getRecentComparisons('user-1', 10);

    expect(result.policyVersion).toContain('neutral-meta-v1');
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]).toMatchObject({
      instrument: 'EURUSD',
      marketBarTime: '2026-10-08T08:35:00.000Z',
      selectionStatus: 'BUY_ELIGIBLE',
      selectedDirection: 'BUY',
      buy: {
        confidence: 0.67,
        grossExpectedR: 0.31,
        netExpectedR: 0.24,
        paperExecutionEligible: true,
        driftState: 'NORMAL',
      },
      sell: {
        confidence: 0.61,
        grossExpectedR: -0.06,
        netExpectedR: -0.11,
        paperExecutionEligible: false,
        driftState: 'OUT_OF_DISTRIBUTION',
        blockers: [
          'ENSEMBLE_NOT_PAPER_ADMITTED',
          'PAPER_NET_EXPECTED_R',
          'DRIFT_OUT_OF_DISTRIBUTION',
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('stopLoss');
    expect(JSON.stringify(result)).not.toContain('takeProfit');
    expect(JSON.stringify(result)).not.toContain('spreadPrice');
  });

  it('fails closed to an empty projection when persistence is unavailable', async () => {
    const service = new AiBidirectionalDecisionService(undefined);
    const result = await service.getRecentComparisons('user-1');
    expect(result.policyVersion).toBeNull();
    expect(result.comparisons).toEqual([]);
  });

  it('does not invent a selected direction when both sides are eligible', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ model_version: 'policy-v1' }])
      .mockResolvedValueOnce(
        (['BUY', 'SELL'] as const).map((side, index) => ({
          model_version: 'policy-v1',
          instrument: 'USDJPY',
          direction: side,
          market_bar_time: '2026-10-08T08:40:00.000Z',
          evaluated_at: `2026-10-08T08:40:1${index}.000Z`,
          confidence: 0.7,
          meta_probability: 0.5,
          expected_r: 0.3,
          regime: 'TREND_HEALTHY',
          consensus_passed: 6,
          consensus_required: 6,
          reasons: ['ADMIT'],
          components: {
            strategyRoute: 'TREND_CONTINUATION',
            paperAdmitted: true,
            governance: {
              netExpectedR: 0.2,
              driftState: 'NORMAL',
              paperExecutionEligible: true,
              paperExecutionBlockers: [],
            },
          },
        })),
      );
    const service = new AiBidirectionalDecisionService({ query } as unknown as DataSource);

    const result = await service.getRecentComparisons('user-1');

    expect(result.comparisons[0]?.selectionStatus).toBe('BOTH_ELIGIBLE');
    expect(result.comparisons[0]?.selectedDirection).toBeNull();
  });
});
