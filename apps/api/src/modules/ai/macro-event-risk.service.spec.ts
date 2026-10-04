import { MacroEventRiskService } from './macro-event-risk.service';

function service(apiKey?: string, fallbackEnabled = true) {
  return new MacroEventRiskService({
    get: jest.fn((key: string, defaultValue?: unknown) => {
      if (key === 'TRADING_ECONOMICS_API_KEY') return apiKey;
      if (key === 'FINANCE_CALENDAR_FALLBACK_ENABLED') {
        return fallbackEnabled ? 'true' : 'false';
      }
      return defaultValue;
    }),
  } as any);
}

function response(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function financePayload(events: unknown[]) {
  return {
    from: '2026-10-04',
    to: '2026-10-06',
    count: events.length,
    events,
    attribution: {
      source: 'financecalendar.com',
      terms: 'Free for any use with attribution',
      docs: 'https://www.financecalendar.com/api/',
    },
  };
}

describe('MacroEventRiskService', () => {
  it('fails closed when every calendar provider is disabled', async () => {
    const result = await service(undefined, false).assess(
      'EURUSD',
      new Date('2026-10-05T12:00:00Z'),
      jest.fn() as any,
    );
    expect(result.state).toBe('UNVERIFIED');
    expect(result.provider).toBe('NONE');
    expect(result.reason).toBe('PROVIDER_NOT_CONFIGURED');
    expect(result.relevantCountries).toEqual(
      expect.arrayContaining(['euro area', 'united states']),
    );
  });

  it('uses Trading Economics as primary when configured', async () => {
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

    expect(result.provider).toBe('TRADING_ECONOMICS');
    expect(result.state).toBe('HIGH_IMPACT_BLOCK');
    expect(result.blockingEvents).toHaveLength(1);
    expect(result.blockingEvents[0]?.event).toBe('Non Farm Payrolls');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the no-key fallback and blocks a relevant timed high-impact event', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      response(
        financePayload([
          {
            date: '2026-10-05',
            time_utc: '2026-10-05T12:30:00+00:00',
            all_day: false,
            name: 'US CPI',
            title: 'US CPI Report October 2026',
            impact: 'high',
            category: 'economic-indicators',
            url: 'https://www.financecalendar.com/event/us-cpi-october-2026/',
          },
        ]),
      ),
    );

    const result = await service().assess(
      'EURUSD',
      new Date('2026-10-05T12:05:00Z'),
      fetchMock as any,
    );

    expect(result.provider).toBe('FINANCE_CALENDAR');
    expect(result.state).toBe('HIGH_IMPACT_BLOCK');
    expect(result.attribution).toEqual({
      label: 'financecalendar.com',
      url: 'https://www.financecalendar.com',
    });
    expect(result.blockingEvents[0]).toEqual(
      expect.objectContaining({
        event: 'US CPI',
        allDay: false,
      }),
    );
  });

  it('blocks the full UTC date for a relevant untimed central-bank event', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      response(
        financePayload([
          {
            date: '2026-10-05',
            time_utc: null,
            all_day: true,
            name: 'Bank of Japan decision',
            title: 'Bank of Japan Rate Decision October 2026',
            impact: 'high',
            category: 'central-banks-monetary-policy',
          },
        ]),
      ),
    );

    const result = await service().assess(
      'USDJPY',
      new Date('2026-10-05T03:00:00Z'),
      fetchMock as any,
    );

    expect(result.state).toBe('HIGH_IMPACT_BLOCK');
    expect(result.blockingEvents[0]).toEqual(
      expect.objectContaining({
        allDay: true,
        country: 'JPY',
      }),
    );
  });

  it('ignores high-impact events mapped only to currencies outside the pair', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      response(
        financePayload([
          {
            date: '2026-10-05',
            time_utc: '2026-10-05T12:30:00+00:00',
            all_day: false,
            name: 'Canada Labour Force Survey',
            title: 'Canada Labour Force Survey October 2026',
            impact: 'high',
          },
        ]),
      ),
    );

    const result = await service().assess(
      'EURUSD',
      new Date('2026-10-05T12:25:00Z'),
      fetchMock as any,
    );

    expect(result.provider).toBe('FINANCE_CALENDAR');
    expect(result.state).toBe('CLEAR');
    expect(result.blockingEvents).toEqual([]);
  });

  it('falls back when Trading Economics is configured but unavailable', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response({}, false, 503))
      .mockResolvedValueOnce(response(financePayload([])));

    const result = await service('key').assess(
      'GBPUSD',
      new Date('2026-10-05T12:00:00Z'),
      fetchMock as any,
    );

    expect(result.provider).toBe('FINANCE_CALENDAR');
    expect(result.state).toBe('CLEAR');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed when both the primary and fallback providers fail', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response({}, false, 503))
      .mockResolvedValueOnce(response({}, false, 502));

    const result = await service('key').assess(
      'GBPUSD',
      new Date('2026-10-05T12:00:00Z'),
      fetchMock as any,
    );

    expect(result.provider).toBe('FINANCE_CALENDAR');
    expect(result.state).toBe('UNVERIFIED');
    expect(result.reason).toContain('PRIMARY_ERROR:HTTP_503');
    expect(result.reason).toContain('FALLBACK_ERROR:HTTP_502');
  });

  it('returns clear when a Trading Economics high-impact event is outside the protective window', async () => {
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

    expect(result.provider).toBe('TRADING_ECONOMICS');
    expect(result.state).toBe('CLEAR');
    expect(result.blockingEvents).toEqual([]);
  });
});
