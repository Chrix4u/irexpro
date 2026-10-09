import { PaperBrokerStateService } from './paper-broker-state.service';

describe('PaperBrokerStateService', () => {
  it('supports an explicit qualification reset to a pristine 10,000 USD simulator without monotonic guards', async () => {
    const repository = {
      findOne: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new PaperBrokerStateService(repository as never);

    await service.resetForQualification('11111111-1111-4111-8111-111111111111');

    expect(repository.query).toHaveBeenCalledTimes(1);
    const [sql, params] = repository.query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (connection_id)');
    expect(sql).not.toContain('marketTickCounter');
    const state = JSON.parse(params[1]);
    expect(state).toEqual({
      version: 1,
      orderCounter: 0,
      marketTickCounter: 0,
      balance: '10000.00',
      working: [],
      positions: [],
      closedTrades: [],
      orderStates: [],
      resultsByDedupeKey: [],
    });
  });

  it('guards durable paper state against stale backward overwrites', async () => {
    const repository = {
      findOne: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    const service = new PaperBrokerStateService(repository as never);

    await service.save('11111111-1111-4111-8111-111111111111', {
      version: 1,
      orderCounter: 3,
      marketTickCounter: 42,
      balance: '10000.00',
      working: [],
      positions: [],
      closedTrades: [],
      orderStates: [],
      resultsByDedupeKey: [],
    });

    expect(repository.query).toHaveBeenCalledTimes(1);
    const [sql] = repository.query.mock.calls[0];
    expect(sql).toContain("EXCLUDED.state ->> 'marketTickCounter'");
    expect(sql).toContain("paper_broker_states.state ->> 'marketTickCounter'");
    expect(sql).toContain("EXCLUDED.state ->> 'orderCounter'");
    expect(sql).toContain("jsonb_array_length(EXCLUDED.state -> 'closedTrades')");
    expect(sql).toContain("jsonb_array_length(EXCLUDED.state -> 'resultsByDedupeKey')");
  });

  it('projects bounded open-position telemetry from durable PAPER state', async () => {
    const repository = {
      findOne: jest.fn().mockResolvedValue({
        state: {
          version: 1,
          positions: [
            {
              positionId: 'paper-position-1',
              pathLastMarkPrice: '1.42613000',
              pathLastMarkObservedAt: '2026-10-09T20:16:01.076Z',
              pathMaxFavorablePnl: '4.20',
              pathMaxAdversePnl: '-1.10',
              pathLatestUnrealisedPnl: '3.10',
              pathObservationCount: 42,
              pathPeakObservedAt: '2026-10-09T20:15:00.000Z',
              pathLastObservedAt: '2026-10-09T20:16:01.076Z',
            },
          ],
        },
      }),
      query: jest.fn(),
    };
    const service = new PaperBrokerStateService(repository as never);

    await expect(
      service.loadOpenPositionTelemetry('11111111-1111-4111-8111-111111111111'),
    ).resolves.toEqual([
      {
        externalPositionId: 'paper-position-1',
        currentPrice: '1.42613000',
        markObservedAt: new Date('2026-10-09T20:16:01.076Z'),
        unrealisedPnl: '3.10',
        maxFavorablePnl: '4.20',
        maxAdversePnl: '-1.10',
        profitGiveback: '1.10',
        observationCount: 42,
        peakObservedAt: new Date('2026-10-09T20:15:00.000Z'),
        lastObservedAt: new Date('2026-10-09T20:16:01.076Z'),
      },
    ]);
  });
});
