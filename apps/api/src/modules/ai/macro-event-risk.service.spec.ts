import { MacroEventRiskService } from './macro-event-risk.service';

function service(apiKey?: string) {
  return new MacroEventRiskService({
    get: jest.fn().mockReturnValue(apiKey),
  } as any);
}

function response(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('MacroEventRiskService', () => {
  it('fails closed when the calendar provider is not configured', async () => {
    const result = await service().assess(
      'EURUSD',
      new Date('2026-10-05T12:00:00Z'),
      jest.fn() as any,
    );
    expect(result.state).toBe('UNVERIFIED');
    expect(result.reason).toBe('PROVIDER_NOT_CONFIGURED');
    expect(result.relevantCountries).toEqual(
      expect.arrayContaining(['euro area', 'united states']),
    );
  });

  it('blocks an importance-3 event inside the protective window', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      response([
        {
          CalendarId: 'nfp-1',
          Date: '2026-10-05T12:30:00',
          Country: 'United States',
          Category: 'Non Farm Payrolls',
          Event: 'Non Farm Payrolls',
          Importance: 3,
          Source: 'U.S. Bureau of Labor Statistics',
        },
      ]),
    );
    const result = await service('key').assess(
      'EURUSD',
      new Date('2026-10-05T12:05:00Z'),
      fetchMock as any,
    );
    expect(result.state).toBe('HIGH_IMPACT_BLOCK');
    expect(result.blockingEvents).toHaveLength(1);
    expect(result.blockingEvents[0]?.event).toBe('Non Farm Payrolls');
  });

  it('returns clear when high-impact events are outside the protective window', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      response([
        {
          Date: '2026-10-05T14:00:00',
          Country: 'United States',
          Event: 'High impact later',
          Importance: 3,
        },
      ]),
    );
    const result = await service('key').assess(
      'USDJPY',
      new Date('2026-10-05T12:00:00Z'),
      fetchMock as any,
    );
    expect(result.state).toBe('CLEAR');
    expect(result.blockingEvents).toEqual([]);
  });

  it('fails closed when the provider is unavailable', async () => {
    const fetchMock = jest.fn().mockResolvedValue(response({}, false, 503));
    const result = await service('key').assess(
      'GBPUSD',
      new Date('2026-10-05T12:00:00Z'),
      fetchMock as any,
    );
    expect(result.state).toBe('UNVERIFIED');
    expect(result.reason).toContain('HTTP_503');
  });
});
