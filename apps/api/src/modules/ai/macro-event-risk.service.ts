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

export interface MacroEventRiskAssessment {
  state: EnsembleEventRiskState;
  provider: 'TRADING_ECONOMICS';
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
  }>;
  reason: string;
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

const BLOCK_BEFORE_MINUTES = 30;
const BLOCK_AFTER_MINUTES = 30;
const CACHE_MS = 15 * 60_000;

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseProviderDate(value: string): Date | null {
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

@Injectable()
export class MacroEventRiskService {
  private readonly cache = new Map<
    string,
    { expiresAt: number; events: TradingEconomicsEvent[] }
  >();

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey());
  }

  async assess(
    instrument: string,
    at: Date,
    fetchImpl: typeof fetch = fetch,
  ): Promise<MacroEventRiskAssessment> {
    const normalizedInstrument = instrument.trim().toUpperCase();
    const currencies =
      normalizedInstrument.length === 6
        ? [normalizedInstrument.slice(0, 3), normalizedInstrument.slice(3, 6)]
        : [];
    const relevantCountries = [
      ...new Set(currencies.map((currency) => CURRENCY_COUNTRY[currency]).filter(Boolean)),
    ];

    const base = {
      provider: 'TRADING_ECONOMICS' as const,
      configured: this.isConfigured(),
      checkedAt: new Date().toISOString(),
      instrument: normalizedInstrument,
      relevantCountries,
      blockWindowMinutesBefore: BLOCK_BEFORE_MINUTES,
      blockWindowMinutesAfter: BLOCK_AFTER_MINUTES,
      blockingEvents: [] as MacroEventRiskAssessment['blockingEvents'],
    };

    if (!this.apiKey()) {
      return {
        ...base,
        state: 'UNVERIFIED',
        reason: 'PROVIDER_NOT_CONFIGURED',
      };
    }
    if (!Number.isFinite(at.getTime()) || relevantCountries.length !== 2) {
      return {
        ...base,
        state: 'UNVERIFIED',
        reason: 'INVALID_INSTRUMENT_OR_TIME',
      };
    }

    try {
      const events = await this.eventsFor(relevantCountries, at, fetchImpl);
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
        ...base,
        state: blockingEvents.length > 0 ? 'HIGH_IMPACT_BLOCK' : 'CLEAR',
        blockingEvents,
        reason:
          blockingEvents.length > 0 ? 'HIGH_IMPACT_EVENT_WINDOW' : 'NO_HIGH_IMPACT_EVENT_WINDOW',
      };
    } catch (error) {
      return {
        ...base,
        state: 'UNVERIFIED',
        reason: `PROVIDER_ERROR:${(error as Error).message}`,
      };
    }
  }

  private async eventsFor(
    countries: string[],
    at: Date,
    fetchImpl: typeof fetch,
  ): Promise<TradingEconomicsEvent[]> {
    const start = new Date(at.getTime() - 24 * 60 * 60_000);
    const end = new Date(at.getTime() + 24 * 60 * 60_000);
    const cacheKey = `${countries.slice().sort().join('|')}:${dateOnly(start)}:${dateOnly(end)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.events;

    const countryPath = countries.map((country) => encodeURIComponent(country)).join(',');
    const url = new URL(
      `https://api.tradingeconomics.com/calendar/country/${countryPath}/${dateOnly(start)}/${dateOnly(end)}`,
    );
    url.searchParams.set('c', this.apiKey()!);
    url.searchParams.set('importance', '3');
    url.searchParams.set('f', 'json');

    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error('INVALID_CALENDAR_PAYLOAD');
    }

    const events = payload as TradingEconomicsEvent[];
    this.cache.set(cacheKey, { expiresAt: Date.now() + CACHE_MS, events });
    return events;
  }

  private apiKey(): string | null {
    const value =
      this.config.get<string>('TRADING_ECONOMICS_API_KEY') ?? process.env.TRADING_ECONOMICS_API_KEY;
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }
}
