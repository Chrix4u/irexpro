import { ConfigService } from '@nestjs/config';
import { AiSignalService } from './ai-signal.service';
import { VpsForexSignalCollectorService } from './vps-forex-signal-collector.service';
import { ExecutionService } from '../execution/execution.service';
import { BrokerService } from '../broker/broker.service';
import { LivePaperMarketDataService } from '../broker/services/live-paper-market-data.service';

function config(): ConfigService {
  return {
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
  } as unknown as ConfigService;
}

function aiEngineClientMock() {
  return {
    isSchedulerIntegrationEnabled: jest.fn().mockReturnValue(true),
    notifySessionStopped: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('full bidirectional shadow outcome learning', () => {
  it('resolves every unresolved decision from the current policy, not only already-admitted decisions', async () => {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT') && String(sql).includes('ensemble_shadow_decisions')) {
        return [
          {
            id: 'rejected-counterfactual',
            instrument: 'EURUSD',
            direction: 'SELL',
            market_bar_time: new Date('2026-10-08T08:00:00.000Z'),
            entry_price: '1.1000',
            components: {
              stopLoss: 1.101,
              takeProfit: 1.0983333333,
              governance: {
                paperExecutionEligible: false,
                estimatedExecutionCostR: 0.05,
              },
            },
          },
        ];
      }
      return [];
    });
    const collector = new VpsForexSignalCollectorService(
      config(),
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      {} as unknown as ExecutionService,
      {} as unknown as BrokerService,
      new LivePaperMarketDataService(),
      aiEngineClientMock(),
      { query } as any,
    );
    const candles = new Map([
      [
        'EURUSD',
        [
          {
            timestamp: new Date('2026-10-08T08:05:00.000Z'),
            open: '1.1000',
            high: '1.1012',
            low: '1.0998',
            close: '1.1009',
          },
        ],
      ],
    ]);

    await (collector as any).resolvePendingEnsembleShadowOutcomes('user-1', 'conn-1', candles);

    const selectCall = query.mock.calls.find(
      ([sql]) =>
        String(sql).includes('SELECT') && String(sql).includes('ensemble_shadow_decisions'),
    );
    expect(selectCall).toBeDefined();
    const selectSql = String(selectCall?.[0]);
    expect(selectSql).toContain('model_version = $4');
    expect(selectSql).not.toContain('admitted = true');
    expect(selectSql).not.toContain('paperExecutionEligible');
    expect(selectSql).not.toContain('highConvictionOverlay');
    expect(selectCall?.[1]).toEqual([
      'user-1',
      'conn-1',
      'irexpro-multimodel-ensemble-v1',
      'plan-b-multimodel-shadow-v4-bidirectional-v2-early-transition-v2-neutral-meta-v1',
    ]);

    const updateCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE trading.ensemble_shadow_decisions'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]?.[0]).toBe('rejected-counterfactual');
    expect(JSON.parse(updateCall?.[1]?.[1] as string)).toMatchObject({
      status: 'LOSS',
      reason: 'STOP_LOSS_HIT',
    });
  });
});
