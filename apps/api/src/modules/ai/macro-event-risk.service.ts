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

interface ShowMyTradesCalendarEvent {
  ts?: number;
  time?: string;
  currency?: string;
  impact?: string;
  title?: string;
  id?: string;
  status?: string;
}

interface ShowMyTradesCalendarPayload {
  server_time?: number;
  server_time_iso?: string;
  generated_at?: string;
  from?: string;
  to?: string;
  count?: number;
  events?: ShowMyTradesCalendarEvent[];
}

export type MacroEventProvider =
  | 'TRADING_ECONOMICS'
  | 'FINANCE_CALENDAR'
  | 'SHOW_MY_TRADES'
  | 'NONE';

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
const SHOW_MY_TRADES_BASE_URL = 'https://showmytrades.com/api/public/calendar/v1';
const SHOW_MY_TRADES_ATTRIBUTION_URL = 'https://showmytrades.com';

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
  private showMyTradesCache: { expiresAt: number; payload: ShowMyTradesCalendarPayload } | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return (
      Boolean(this.apiKey()) ||
      this.financeCalendarFallbackEnabled() ||
      this.showMyTradesFallbackEnabled()
    );
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

    let financeCalendarError: string | null = null;
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
        financeCalendarError = (error as Error).message;
      }
    }

    let showMyTradesError: string | null = null;
    if (this.showMyTradesFallbackEnabled()) {
      try {
        return await this.assessShowMyTrades(
          normalizedInstrument,
          currencies,
          relevantCountries,
          at,
          fetchImpl,
        );
      } catch (error) {
        showMyTradesError = (error as Error).message;
      }
    }

    const errors = [
      primaryError ? `PRIMARY_ERROR:${primaryError}` : null,
      financeCalendarError ? `FINANCE_CALENDAR_ERROR:${financeCalendarError}` : null,
      showMyTradesError ? `SHOW_MY_TRADES_ERROR:${showMyTradesError}` : null,
    ].filter((value): value is string => Boolean(value));

    return {
      ...base,
      provider: showMyTradesError
        ? 'SHOW_MY_TRADES'
        : financeCalendarError
          ? 'FINANCE_CALENDAR'
          : this.apiKey()
            ? 'TRADING_ECONOMICS'
            : 'NONE',
      state: 'UNVERIFIED',
      reason: errors.length > 0 ? errors.join(';') : 'PROVIDER_NOT_CONFIGURED',
      attribution: showMyTradesError
        ? { label: 'showmytrades.com', url: SHOW_MY_TRADES_ATTRIBUTION_URL }
        : financeCalendarError
          ? { label: 'financecalendar.com', url: FINANCE_CALENDAR_ATTRIBUTION_URL }
          : null,
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

  private async assessShowMyTrades(
    instrument: string,
    relevantCurrencies: string[],
    relevantCountries: string[],
    at: Date,
    fetchImpl: typeof fetch,
  ): Promise<MacroEventRiskAssessment> {
    const payload = await this.showMyTradesEventsFor(fetchImpl);
    const events = payload.events;
    if (!Array.isArray(events)) throw new Error('INVALID_SHOW_MY_TRADES_PAYLOAD');

    const beforeMs = BLOCK_BEFORE_MINUTES * 60_000;
    const afterMs = BLOCK_AFTER_MINUTES * 60_000;
    const blockingEvents: MacroEventRiskAssessment['blockingEvents'] = [];

    for (const event of events) {
      if ((event.impact ?? '').trim().toLowerCase() !== 'high') continue;
      if ((event.status ?? '').trim().toLowerCase() === 'cancelled') continue;
      if ((event.status ?? '').trim().toLowerCase() === 'canceled') continue;

      const currency = (event.currency ?? '').trim().toUpperCase();
      if (!relevantCurrencies.includes(currency)) continue;

      const eventTime = event.time
        ? parseProviderDate(event.time)
        : Number.isFinite(event.ts)
          ? new Date(Number(event.ts) * 1000)
          : null;
      if (!eventTime || !Number.isFinite(eventTime.getTime())) {
        throw new Error('RELEVANT_SHOW_MY_TRADES_EVENT_INVALID_TIME');
      }

      const delta = at.getTime() - eventTime.getTime();
      if (delta < -beforeMs || delta > afterMs) continue;
      blockingEvents.push({
        id: event.id ?? null,
        date: eventTime.toISOString(),
        country: currency || null,
        category: null,
        event: event.title ?? null,
        importance: 3,
        source: 'showmytrades.com',
        url: null,
        allDay: false,
      });
    }

    return {
      provider: 'SHOW_MY_TRADES',
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
        label: 'showmytrades.com',
        url: SHOW_MY_TRADES_ATTRIBUTION_URL,
      },
    };
  }

  private async showMyTradesEventsFor(
    fetchImpl: typeof fetch,
  ): Promise<ShowMyTradesCalendarPayload> {
    const cached = this.showMyTradesCache;
    if (cached && cached.expiresAt > Date.now()) return cached.payload;

    const response = await fetchImpl(SHOW_MY_TRADES_BASE_URL, {
      headers: { 'User-Agent': 'iRexPro/1.0 macro-risk-guard' },
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const payload = (await response.json()) as ShowMyTradesCalendarPayload;
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events)) {
      throw new Error('INVALID_SHOW_MY_TRADES_PAYLOAD');
    }

    this.showMyTradesCache = {
      expiresAt: Date.now() + CACHE_MS,
      payload,
    };
    return payload;
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

  private showMyTradesFallbackEnabled(): boolean {
    const configured = this.config.get<string>('SHOW_MY_TRADES_FALLBACK_ENABLED', 'true');
    return String(configured).trim().toLowerCase() !== 'false';
  }
}
