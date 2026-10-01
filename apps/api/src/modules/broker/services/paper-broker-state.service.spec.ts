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
});
