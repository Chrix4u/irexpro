import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnsembleEventRiskState } from './ensemble-governance';

interface TradingEconomicsEvent {
  CalendarId?: string | number;
  Date?: string;
  Country?: string;
  Category?: string;
  Event?: string;
  Importance?: number | string;
  Source?: string;
}

interface FinanceCalendarEvent {
  date?: string;
  time_utc?: string | null;
  all_day?: boolean;
  name?: string;
  title?: string;
  impact?: string;
  category?: string;
  url?: string;
}

interface FinanceCalendarPayload {
  from?: string;
  to?: string;
  count?: number;
  events?: FinanceCalendarEvent[];
  attribution?: {
    source?: string;
    terms?: string;
    docs?: string;
  };
}

export type MacroEventProvider = 'TRADING_ECONOMICS' | 'FINANCE_CALENDAR' | 'NONE';

export interface MacroEventRiskAssessment {
  state: EnsembleEventRiskState;
  provider: MacroEventProvider;
  configured: boolean;
  checkedAt: string;
  instrument: string;
  relevantCountries: string[];
  blockWindowMinutesBefore: number;
  blockWindowMinutesAfter: number;
  blockingEvents: Array<{
    id: string | null;
    date: string;
    country: string | null;
    category: string | null;
    event: string | null;
    importance: number;
    source: string | null;
    url?: string | null;
    allDay?: boolean;
  }>;
  reason: string;
  attribution: {
    label: string;
    url: string;
  } | null;
}

const CURRENCY_COUNTRY: Record<string, string> = Object.freeze({
  USD: 'united states',
  EUR: 'euro area',
  GBP: 'united kingdom',
  JPY: 'japan',
  AUD: 'australia',
  CAD: 'canada',
  CHF: 'switzerland',
});

const FINANCE_CURRENCY_HINTS: ReadonlyArray<{
  currency: string;
  pattern: RegExp;
}> = Object.freeze([
  { currency: 'USD', pattern: /\b(us|u\.s\.|united states|fomc|federal reserve|fed)\b/i },
  { currency: 'EUR', pattern: /\b(eurozone|euro area|ecb|european central bank)\b/i },
  { currency: 'GBP', pattern: /\b(uk|united kingdom|boe|bank of england)\b/i },
  { currency: 'JPY', pattern: /\b(japan|boj|bank of japan)\b/i },
  { currency: 'AUD', pattern: /\b(australia|rba|reserve bank of australia)\b/i },
  { currency: 'CAD', pattern: /\b(canada|boc|bank of canada)\b/i },
  { currency: 'CHF', pattern: /\b(switzerland|swiss|snb|swiss national bank)\b/i },
]);

const BLOCK_BEFORE_MINUTES = 30;
const BLOCK_AFTER_MINUTES = 30;
const CACHE_MS = 15 * 60_000;
const FINANCE_CALENDAR_BASE_URL = 'https://www.financecalendar.com/wp-json/fc/v1/calendar';
const FINANCE_CALENDAR_ATTRIBUTION_URL = 'https://www.financecalendar.com';

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseProviderDate(value: string): Date | null {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function relevantCurrenciesForInstrument(instrument: string): string[] {
  const normalized = instrument.trim().toUpperCase();
  if (normalized.length !== 6) return [];
  const currencies = [normalized.slice(0, 3), normalized.slice(3, 6)];
  return currencies.every((currency) => Boolean(CURRENCY_COUNTRY[currency])) ? currencies : [];
}

function financeCurrencies(event: FinanceCalendarEvent): string[] {
  const text = [event.name, event.title, event.category].filter(Boolean).join(' ');
  return FINANCE_CURRENCY_HINTS.filter(({ pattern }) => pattern.test(text)).map(
    ({ currency }) => currency,
  );
}

@Injectable()
export class MacroEventRiskService {
  private readonly tradingEconomicsCache = new Map<
    string,
    { expiresAt: number; events: TradingEconomicsEvent[] }
  >();
  private readonly financeCalendarCache = new Map<
    string,
    { expiresAt: number; payload: FinanceCalendarPayload }
  >();

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey()) || this.financeCalendarFallbackEnabled();
  }

  async assess(
    instrument: string,
    at: Date,
    fetchImpl: typeof fetch = fetch,
  ): Promise<MacroEventRiskAssessment> {
    const normalizedInstrument = instrument.trim().toUpperCase();
    const currencies = relevantCurrenciesForInstrument(normalizedInstrument);
    const relevantCountries = currencies.map((currency) => CURRENCY_COUNTRY[currency]!);

    const base = {
      configured: this.isConfigured(),
      checkedAt: new Date().toISOString(),
      instrument: normalizedInstrument,
      relevantCountries,
      blockWindowMinutesBefore: BLOCK_BEFORE_MINUTES,
      blockWindowMinutesAfter: BLOCK_AFTER_MINUTES,
      blockingEvents: [] as MacroEventRiskAssessment['blockingEvents'],
    };

    if (!Number.isFinite(at.getTime()) || currencies.length !== 2) {
      return {
        ...base,
        provider: 'NONE',
        state: 'UNVERIFIED',
        reason: 'INVALID_INSTRUMENT_OR_TIME',
        attribution: null,
      };
    }

    let primaryError: string | null = null;
    if (this.apiKey()) {
      try {
        return await this.assessTradingEconomics(
          normalizedInstrument,
          relevantCountries,
          at,
          fetchImpl,
        );
      } catch (error) {
        primaryError = (error as Error).message;
      }
    }

    if (this.financeCalendarFallbackEnabled()) {
      try {
        return await this.assessFinanceCalendar(
          normalizedInstrument,
          currencies,
          relevantCountries,
          at,
          fetchImpl,
        );
      } catch (error) {
        const fallbackError = (error as Error).message;
        return {
          ...base,
          provider: 'FINANCE_CALENDAR',
          state: 'UNVERIFIED',
          reason: primaryError
            ? `PRIMARY_ERROR:${primaryError};FALLBACK_ERROR:${fallbackError}`
            : `PROVIDER_ERROR:${fallbackError}`,
          attribution: {
            label: 'financecalendar.com',
            url: FINANCE_CALENDAR_ATTRIBUTION_URL,
          },
        };
      }
    }

    return {
      ...base,
      provider: this.apiKey() ? 'TRADING_ECONOMICS' : 'NONE',
      state: 'UNVERIFIED',
      reason: primaryError ? `PROVIDER_ERROR:${primaryError}` : 'PROVIDER_NOT_CONFIGURED',
      attribution: null,
    };
  }

  private async assessTradingEconomics(
    instrument: string,
    relevantCountries: string[],
    at: Date,
    fetchImpl: typeof fetch,
  ): Promise<MacroEventRiskAssessment> {
    const events = await this.tradingEconomicsEventsFor(relevantCountries, at, fetchImpl);
    const beforeMs = BLOCK_BEFORE_MINUTES * 60_000;
    const afterMs = BLOCK_AFTER_MINUTES * 60_000;
    const blockingEvents = events
      .map((event) => {
        const date = event.Date ? parseProviderDate(event.Date) : null;
        const importance = Number(event.Importance ?? 0);
        if (!date || importance < 3) return null;
        const delta = at.getTime() - date.getTime();
        if (delta < -beforeMs || delta > afterMs) return null;
        return {
          id: event.CalendarId == null ? null : String(event.CalendarId),
          date: date.toISOString(),
          country: event.Country ?? null,
          category: event.Category ?? null,
          event: event.Event ?? null,
          importance,
          source: event.Source ?? null,
        };
      })
      .filter((event): event is NonNullable<typeof event> => event !== null);

    return {
      provider: 'TRADING_ECONOMICS',
      configured: true,
      checkedAt: new Date().toISOString(),
      instrument,
      relevantCountries,
      blockWindowMinutesBefore: BLOCK_BEFORE_MINUTES,
      blockWindowMinutesAfter: BLOCK_AFTER_MINUTES,
      blockingEvents,
      state: blockingEvents.length > 0 ? 'HIGH_IMPACT_BLOCK' : 'CLEAR',
      reason:
        blockingEvents.length > 0 ? 'HIGH_IMPACT_EVENT_WINDOW' : 'NO_HIGH_IMPACT_EVENT_WINDOW',
      attribution: null,
    };
  }

  private async assessFinanceCalendar(
    instrument: string,
    relevantCurrencies: string[],
    relevantCountries: string[],
    at: Date,
    fetchImpl: typeof fetch,
  ): Promise<MacroEventRiskAssessment> {
    const payload = await this.financeCalendarEventsFor(at, fetchImpl);
    const events = payload.events;
    if (!Array.isArray(events)) throw new Error('INVALID_FINANCE_CALENDAR_PAYLOAD');

    const beforeMs = BLOCK_BEFORE_MINUTES * 60_000;
    const afterMs = BLOCK_AFTER_MINUTES * 60_000;
    const blockingEvents: MacroEventRiskAssessment['blockingEvents'] = [];

    for (const event of events) {
      if ((event.impact ?? '').toLowerCase() !== 'high') continue;
      const currencies = financeCurrencies(event);
      if (!currencies.some((currency) => relevantCurrencies.includes(currency))) continue;

      const eventDate = event.date?.trim();
      if (!eventDate) {
        throw new Error('RELEVANT_FINANCE_EVENT_MISSING_DATE');
      }

      if (!event.time_utc || event.all_day) {
        if (dateOnly(at) !== eventDate) continue;
        blockingEvents.push({
          id: event.url ?? null,
          date: `${eventDate}T00:00:00.000Z`,
          country: currencies.join(','),
          category: event.category ?? null,
          event: event.name ?? event.title ?? null,
          importance: 3,
          source: 'financecalendar.com',
          url: event.url ?? null,
          allDay: true,
        });
        continue;
      }

      const eventTime = parseProviderDate(event.time_utc);
      if (!eventTime) {
        throw new Error('RELEVANT_FINANCE_EVENT_INVALID_TIME');
      }
      const delta = at.getTime() - eventTime.getTime();
      if (delta < -beforeMs || delta > afterMs) continue;
      blockingEvents.push({
        id: event.url ?? null,
        date: eventTime.toISOString(),
        country: currencies.join(','),
        category: event.category ?? null,
        event: event.name ?? event.title ?? null,
        importance: 3,
        source: 'financecalendar.com',
        url: event.url ?? null,
        allDay: false,
      });
    }

    return {
      provider: 'FINANCE_CALENDAR',
      configured: true,
      checkedAt: new Date().toISOString(),
      instrument,
      relevantCountries,
      blockWindowMinutesBefore: BLOCK_BEFORE_MINUTES,
      blockWindowMinutesAfter: BLOCK_AFTER_MINUTES,
      blockingEvents,
      state: blockingEvents.length > 0 ? 'HIGH_IMPACT_BLOCK' : 'CLEAR',
      reason:
        blockingEvents.length > 0 ? 'HIGH_IMPACT_EVENT_WINDOW' : 'NO_HIGH_IMPACT_EVENT_WINDOW',
      attribution: {
        label: payload.attribution?.source || 'financecalendar.com',
        url: FINANCE_CALENDAR_ATTRIBUTION_URL,
      },
    };
  }

  private async tradingEconomicsEventsFor(
    countries: string[],
    at: Date,
    fetchImpl: typeof fetch,
  ): Promise<TradingEconomicsEvent[]> {
    const start = new Date(at.getTime() - 24 * 60 * 60_000);
    const end = new Date(at.getTime() + 24 * 60 * 60_000);
    const cacheKey = `${countries.slice().sort().join('|')}:${dateOnly(start)}:${dateOnly(end)}`;
    const cached = this.tradingEconomicsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.events;

    const countryPath = countries.map((country) => encodeURIComponent(country)).join(',');
    const url = new URL(
      `https://api.tradingeconomics.com/calendar/country/${countryPath}/${dateOnly(start)}/${dateOnly(end)}`,
    );
    url.searchParams.set('c', this.apiKey()!);
    url.searchParams.set('importance', '3');
    url.searchParams.set('f', 'json');

    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) throw new Error('INVALID_CALENDAR_PAYLOAD');

    const events = payload as TradingEconomicsEvent[];
    this.tradingEconomicsCache.set(cacheKey, { expiresAt: Date.now() + CACHE_MS, events });
    return events;
  }

  private async financeCalendarEventsFor(
    at: Date,
    fetchImpl: typeof fetch,
  ): Promise<FinanceCalendarPayload> {
    const start = new Date(at.getTime() - 24 * 60 * 60_000);
    const end = new Date(at.getTime() + 24 * 60 * 60_000);
    const cacheKey = `${dateOnly(start)}:${dateOnly(end)}`;
    const cached = this.financeCalendarCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.payload;

    const url = new URL(FINANCE_CALENDAR_BASE_URL);
    url.searchParams.set('from', dateOnly(start));
    url.searchParams.set('to', dateOnly(end));
    url.searchParams.set('impact', 'high');
    url.searchParams.set('limit', '200');

    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'iRexPro/1.0 macro-risk-guard' },
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const payload = (await response.json()) as FinanceCalendarPayload;
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events)) {
      throw new Error('INVALID_FINANCE_CALENDAR_PAYLOAD');
    }

    this.financeCalendarCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_MS,
      payload,
    });
    return payload;
  }

  private apiKey(): string | null {
    const value =
      this.config.get<string>('TRADING_ECONOMICS_API_KEY') ?? process.env.TRADING_ECONOMICS_API_KEY;
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  private financeCalendarFallbackEnabled(): boolean {
    const configured = this.config.get<string>('FINANCE_CALENDAR_FALLBACK_ENABLED', 'true');
    return String(configured).trim().toLowerCase() !== 'false';
  }
}
