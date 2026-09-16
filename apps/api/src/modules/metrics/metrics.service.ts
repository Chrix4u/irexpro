import { Injectable, Logger } from '@nestjs/common';

/**
 * Round 7 (P1 metrics — audit R7-audit-C finding A6): the dependency-free,
 * in-process typed counter/gauge registry.
 *
 * CONTRACT (mirrors the instrumentation call-site discipline):
 *  - increment()/setGauge()/removeGauge() NEVER throw — every public method
 *    body is fail-safe; observability can never break trading control flow.
 *    Instrumented services therefore call them as bare synchronous one-liners
 *    (no try/catch at the call sites).
 *  - Names and label keys/values are sanitized to the whitelist
 *    [a-zA-Z0-9_:-] (invalid characters replaced with '_', truncation to
 *    LABEL_MAX_LENGTH). Empty/missing/whole-invalid label tokens collapse to
 *    '_'; label values that are not string|number (objects, null, undefined)
 *    ALSO collapse to '_' — arbitrary objects are never stringified into
 *    labels (redaction discipline: no accidental secret leakage).
 *  - Unknown metric names are accepted (counted under the sanitized name) —
 *    but production call sites use the METRIC_NAMES catalog.
 *  - Counters are monotonic: non-finite and negative increments are ignored
 *    (no series registered); zero increments register the series without
 *    changing its value.
 *  - Gauges are point-in-time values: setGauge overwrites the series;
 *    removeGauge drops every series of one gauge name (used by the
 *    on-scrape DB-backed gauges to fail-open).
 *  - A bounded ring buffer of the most recent RECENT_INCREMENT_LIMIT
 *    increments is retained for debugging (never surfaced with secrets —
 *    labels are already sanitized).
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  /** metric name → series key → series */
  private readonly counters = new Map<string, Map<string, MetricSeries>>();
  /** gauge name → series key → series */
  private readonly gauges = new Map<string, Map<string, MetricSeries>>();
  /** bounded most-recent-increments ring buffer */
  private readonly recentIncrements: RecentMetricIncrement[] = [];

  /**
   * Increment a counter series. Never throws.
   *
   * @param name   metric name (see METRIC_NAMES; unknown names accepted)
   * @param labels optional label set (keys/values sanitized)
   * @param value  increment amount (default 1); non-finite/negative ignored
   */
  increment(name: string, labels?: Record<string, string | number>, value = 1): void {
    try {
      if (typeof name !== 'string' || name.length === 0) return;
      const safeName = sanitizeMetricToken(name);
      if (typeof value !== 'number' || !Number.isFinite(value)) return; // non-finite ignored
      const numericValue = value;
      if (numericValue < 0) return; // counters are monotonic — never decrement
      const safeLabels = sanitizeLabels(labels);
      this.applyToStore(this.counters, safeName, safeLabels, (existing) =>
        numericValue === 0 && !existing ? 0 : (existing ?? 0) + numericValue,
      );
      this.pushRecent(safeName, safeLabels, numericValue);
    } catch (err) {
      this.logger.warn(`Metrics increment failed (ignored): ${(err as Error).message}`);
    }
  }

  /**
   * Set a gauge series value (point-in-time). Never throws.
   * Used by the on-scrape DB-backed gauges (MetricsController) and any
   * future periodic gauge refresher.
   */
  setGauge(name: string, value: number, labels?: Record<string, string | number>): void {
    try {
      if (typeof name !== 'string' || name.length === 0) return;
      const safeName = sanitizeMetricToken(name);
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      const safeLabels = sanitizeLabels(labels);
      this.applyToStore(this.gauges, safeName, safeLabels, () => value);
    } catch (err) {
      this.logger.warn(`Metrics setGauge failed (ignored): ${(err as Error).message}`);
    }
  }

  /**
   * Drop EVERY series of one gauge name. Never throws. The on-scrape gauges
   * call this on backing-query failure so a failed scrape never serves stale
   * gauge values (fail-open = omitted lines, never fabricated ones).
   */
  removeGauge(name: string): void {
    try {
      if (typeof name !== 'string' || name.length === 0) return;
      const safeName = sanitizeMetricToken(name);
      this.gauges.delete(safeName);
    } catch (err) {
      this.logger.warn(`Metrics removeGauge failed (ignored): ${(err as Error).message}`);
    }
  }

  /**
   * Deterministic point-in-time snapshot of every counter/gauge series plus
   * the bounded recent-increment buffer (tests + the /metrics endpoint).
   * Series are sorted by (name, series key) for stable output.
   */
  snapshot(): MetricsSnapshot {
    return {
      generatedAt: new Date().toISOString(),
      counters: this.flattenSorted(this.counters),
      gauges: this.flattenSorted(this.gauges),
      recent: this.recentIncrements.map((entry) => ({ ...entry, labels: { ...entry.labels } })),
    };
  }

  /** Clear all state (test isolation helper). Never throws. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.recentIncrements.length = 0;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private applyToStore(
    store: Map<string, Map<string, MetricSeries>>,
    name: string,
    labels: Record<string, string>,
    compute: (existing: number | undefined) => number,
  ): void {
    const key = seriesKey(labels);
    let series = store.get(name);
    if (!series) {
      series = new Map<string, MetricSeries>();
      store.set(name, series);
    }
    const existing = series.get(key)?.value;
    series.set(key, { name, labels, value: compute(existing) });
  }

  private pushRecent(name: string, labels: Record<string, string>, value: number): void {
    this.recentIncrements.push({
      at: new Date().toISOString(),
      name,
      labels: { ...labels },
      value,
    });
    if (this.recentIncrements.length > RECENT_INCREMENT_LIMIT) {
      this.recentIncrements.splice(0, this.recentIncrements.length - RECENT_INCREMENT_LIMIT);
    }
  }

  private flattenSorted(store: Map<string, Map<string, MetricSeries>>): MetricSeriesSnapshot[] {
    const flat: MetricSeriesSnapshot[] = [];
    for (const series of store.values()) {
      for (const entry of series.values()) {
        flat.push({ name: entry.name, labels: { ...entry.labels }, value: entry.value });
      }
    }
    flat.sort((a, b) =>
      a.name === b.name
        ? seriesKey(a.labels).localeCompare(seriesKey(b.labels))
        : a.name.localeCompare(b.name),
    );
    return flat;
  }
}

// ─── Module-level pure helpers ───────────────────────────────────────────────

/** Max retained metric name / label key / label value length. */
export const LABEL_MAX_LENGTH = 100;
/** Characters allowed in metric names and label keys/values. */
const DISALLOWED_METRIC_CHARS = /[^a-zA-Z0-9_:-]/g;
/** Bounded recent-increment ring buffer size. */
export const RECENT_INCREMENT_LIMIT = 100;

/** One counter/gauge series (a metric name + a fully-resolved label set). */
export interface MetricSeries {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** One bounded ring-buffer entry (debugging aid). */
export interface RecentMetricIncrement {
  at: string;
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Deterministic snapshot returned by MetricsService.snapshot(). */
export interface MetricsSnapshot {
  generatedAt: string;
  counters: MetricSeriesSnapshot[];
  gauges: MetricSeriesSnapshot[];
  recent: RecentMetricIncrement[];
}

export interface MetricSeriesSnapshot {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Sanitize one metric/label token: whitelist [a-zA-Z0-9_:-], replace invalid
 * characters with '_', truncate to LABEL_MAX_LENGTH, never return empty.
 * Numbers stringify; any other non-string input collapses to '_' (never
 * String() arbitrary objects into metrics labels).
 */
export function sanitizeMetricToken(token: string | number): string {
  const raw = typeof token === 'number' ? String(token) : token;
  if (!raw || typeof raw !== 'string') return '_';
  const sanitized = raw.replace(DISALLOWED_METRIC_CHARS, '_').slice(0, LABEL_MAX_LENGTH);
  return sanitized.length > 0 ? sanitized : '_';
}

/** Sanitize a full label set (keys AND values); returns a fresh object. */
function sanitizeLabels(labels?: Record<string, string | number>): Record<string, string> {
  if (!labels || typeof labels !== 'object') return {};
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    safe[sanitizeMetricToken(key)] = sanitizeMetricToken(value ?? '_');
  }
  return safe;
}

/** Stable series key for a sanitized label set (sorted keys). */
function seriesKey(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((key) => `${key}=${labels[key]}`).join('|');
}
