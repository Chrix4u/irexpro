import { PaperBrokerStateService } from './paper-broker-state.service';

describe('PaperBrokerStateService', () => {
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
