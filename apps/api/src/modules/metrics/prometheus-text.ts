import { METRIC_HELP } from './metric-names';
import type { MetricSeriesSnapshot, MetricsSnapshot } from './metrics.service';

/**
 * Round 7 (P1 metrics — audit R7-audit-C finding A6): hand-written Prometheus
 * TEXT exposition renderer (no prom-client dependency).
 *
 * Format (https://prometheus.io/docs/instrumenting/exposition_formats/):
 *   # HELP <name> <help text>
 *   # TYPE <name> counter|gauge
 *   <name>{<label>="<value>",...} <value>
 *   <name> <value>                  (label-less series)
 *
 * Escaping rules implemented:
 *  - label VALUES: backslash → \\, newline → \n, double-quote → \" (the three
 *    escapes the text format defines)
 *  - HELP text: backslash → \\, newline → \n
 *  - metric names and label KEYS are already sanitized upstream
 *    (MetricsService whitelist [a-zA-Z0-9_:-]) so they need no escaping
 *
 * Series ordering is deterministic: snapshot order (name, then series key).
 */

/** Escape a Prometheus text-format label value. */
export function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

/** Escape a HELP text line (backslash + newline only). */
function escapeHelpText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Format one sample line: name{labels} value or name value. */
function formatSample(series: MetricSeriesSnapshot): string {
  const keys = Object.keys(series.labels).sort();
  const labelsPart =
    keys.length > 0
      ? `{${keys.map((key) => `${key}="${escapePrometheusLabelValue(series.labels[key])}"`).join(',')}}`
      : '';
  return `${series.name}${labelsPart} ${formatValue(series.value)}`;
}

/** Integer values render without a decimal point; others via Number → string. */
function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function helpFor(name: string): string {
  return escapeHelpText(METRIC_HELP[name] ?? `iRexPro API metric ${name}`);
}

/** Render one metric family (all series sharing a name) with HELP/TYPE headers. */
function renderFamily(
  lines: string[],
  name: string,
  series: MetricSeriesSnapshot[],
  type: 'counter' | 'gauge',
): void {
  lines.push(`# HELP ${name} ${helpFor(name)}`);
  lines.push(`# TYPE ${name} ${type}`);
  for (const entry of series) {
    lines.push(formatSample(entry));
  }
}

/**
 * Render a full MetricsSnapshot to Prometheus text exposition format.
 * Counters are emitted first, then gauges; every distinct metric name gets
 * exactly one HELP/TYPE header pair.
 */
export function renderPrometheusText(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];
  const countersByName = groupByName(snapshot.counters);
  for (const [name, series] of countersByName) {
    renderFamily(lines, name, series, 'counter');
  }
  const gaugesByName = groupByName(snapshot.gauges);
  for (const [name, series] of gaugesByName) {
    renderFamily(lines, name, series, 'gauge');
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** Group pre-sorted series by metric name (preserving order). */
function groupByName(series: MetricSeriesSnapshot[]): Map<string, MetricSeriesSnapshot[]> {
  const grouped = new Map<string, MetricSeriesSnapshot[]>();
  for (const entry of series) {
    const bucket = grouped.get(entry.name);
    if (bucket) {
      bucket.push(entry);
    } else {
      grouped.set(entry.name, [entry]);
    }
  }
  return grouped;
}
