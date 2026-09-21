import { MetricsService, LABEL_MAX_LENGTH, RECENT_INCREMENT_LIMIT } from './metrics.service';
import { METRIC_GAUGE_NAMES, METRIC_NAMES } from './metric-names';

describe('MetricsService — in-process counter/gauge registry', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
  });

  describe('counters — increment()', () => {
    it('increments an unlabeled counter by 1 by default', () => {
      service.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED);
      service.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED);
      const snapshot = service.snapshot();
      expect(snapshot.counters).toEqual([
        { name: METRIC_NAMES.AI_SIGNALS_RECEIVED, labels: {}, value: 2 },
      ]);
    });

    it('accumulates custom increment values', () => {
      service.increment(METRIC_NAMES.INTENTS_EXPIRED, undefined, 3);
      service.increment(METRIC_NAMES.INTENTS_EXPIRED, undefined, 4);
      const snapshot = service.snapshot();
      expect(snapshot.counters[0]).toEqual({
        name: METRIC_NAMES.INTENTS_EXPIRED,
        labels: {},
        value: 7,
      });
    });

    it('keeps separate series per label set and aggregates within one', () => {
      service.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, { outcome: 'EXECUTION_SUCCEEDED' });
      service.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, { outcome: 'EXECUTION_SUCCEEDED' });
      service.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, { outcome: 'RISK_REJECTED' });
      const snapshot = service.snapshot();
      expect(snapshot.counters).toEqual([
        {
          name: METRIC_NAMES.AI_SIGNALS_RECEIVED,
          labels: { outcome: 'EXECUTION_SUCCEEDED' },
          value: 2,
        },
        { name: METRIC_NAMES.AI_SIGNALS_RECEIVED, labels: { outcome: 'RISK_REJECTED' }, value: 1 },
      ]);
    });

    it('accepts UNKNOWN metric names (sanitized) — the catalog is a convention, not a gate', () => {
      service.increment('custom_experimental_counter', { source: 'test' });
      const snapshot = service.snapshot();
      expect(snapshot.counters).toEqual([
        { name: 'custom_experimental_counter', labels: { source: 'test' }, value: 1 },
      ]);
    });

    it('registers a zero increment as a 0-valued series without changing existing values', () => {
      service.increment(METRIC_NAMES.CONFIRMATIONS_EXPIRED, undefined, 5);
      service.increment(METRIC_NAMES.CONFIRMATIONS_EXPIRED, undefined, 0);
      service.increment(METRIC_NAMES.ALLOCATIONS_RELEASED, undefined, 0);
      const snapshot = service.snapshot();
      expect(snapshot.counters).toEqual([
        { name: METRIC_NAMES.ALLOCATIONS_RELEASED, labels: {}, value: 0 },
        { name: METRIC_NAMES.CONFIRMATIONS_EXPIRED, labels: {}, value: 5 },
      ]);
    });

    it('ignores negative increments (counters are monotonic)', () => {
      service.increment(METRIC_NAMES.RISK_APPROVALS, undefined, 2);
      service.increment(METRIC_NAMES.RISK_APPROVALS, undefined, -5);
      const snapshot = service.snapshot();
      expect(snapshot.counters[0].value).toBe(2);
    });

    it('ignores non-finite increments without registering a series', () => {
      service.increment(METRIC_NAMES.RISK_APPROVALS, undefined, Number.NaN);
      service.increment(METRIC_NAMES.RISK_REJECTIONS, undefined, Number.POSITIVE_INFINITY);
      expect(service.snapshot().counters).toEqual([]);
    });
  });

  describe('label sanitization', () => {
    it('replaces characters outside [a-zA-Z0-9_:-] with underscores in keys and values', () => {
      service.increment(METRIC_NAMES.DISPATCH_BLOCKS, {
        'gate!name': 'EXECUTION CONTROL/blocked',
      });
      const snapshot = service.snapshot();
      expect(snapshot.counters).toEqual([
        {
          name: METRIC_NAMES.DISPATCH_BLOCKS,
          labels: { gate_name: 'EXECUTION_CONTROL_blocked' },
          value: 1,
        },
      ]);
    });

    it('truncates label keys and values to 100 characters', () => {
      const longValue = `a`.repeat(250);
      const longKey = `k`.repeat(150);
      service.increment(METRIC_NAMES.SIZING_FAILURES, { [longKey]: longValue });
      const [series] = service.snapshot().counters;
      expect(Object.keys(series.labels)[0].length).toBe(LABEL_MAX_LENGTH);
      expect(series.labels[Object.keys(series.labels)[0]].length).toBe(LABEL_MAX_LENGTH);
    });

    it('stringifies numeric label values', () => {
      service.increment(METRIC_NAMES.DISPATCH_ATTEMPTS, { operationClass: 42 });
      const [series] = service.snapshot().counters;
      expect(series.labels.operationClass).toBe('42');
    });

    it('maps empty/whole-invalid/missing tokens to a placeholder, never empty strings', () => {
      service.increment(METRIC_NAMES.PROVIDER_REJECTS, { reason: '', other: '###' });
      const [series] = service.snapshot().counters;
      expect(series.labels.reason).toBe('_');
      expect(series.labels.other).toBe('___'); // per-char replacement keeps length
    });

    it('never throws on hostile label inputs (null/undefined/nested values)', () => {
      expect(() =>
        service.increment(METRIC_NAMES.PROVIDER_REJECTS, {
          bad: null as unknown as string,
          worse: undefined as unknown as string,
          nested: { deep: true } as unknown as string,
        }),
      ).not.toThrow();
      const [series] = service.snapshot().counters;
      // Non string|number label values collapse to '_' — arbitrary objects are
      // NEVER String()-ified into metrics labels (redaction discipline).
      expect(series.labels).toEqual({ bad: '_', worse: '_', nested: '_' });
    });

    it('never throws on a missing/invalid name (empty ignored; invalid chars replaced)', () => {
      expect(() => service.increment('')).not.toThrow();
      expect(() => service.increment(undefined as unknown as string)).not.toThrow();
      expect(() => service.increment('###')).not.toThrow();
      // Empty/absent names are IGNORED; '###' sanitizes to '___' and counts
      expect(service.snapshot().counters).toEqual([{ name: '___', labels: {}, value: 1 }]);
    });
  });

  describe('gauges — setGauge()/removeGauge()', () => {
    it('sets and OVERWRITES a gauge value (point-in-time semantics)', () => {
      service.setGauge(METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE, 5);
      service.setGauge(METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE, 7);
      expect(service.snapshot().gauges).toEqual([
        { name: METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE, labels: {}, value: 7 },
      ]);
    });

    it('keeps separate gauge series per label set and removes every series by name', () => {
      service.setGauge(METRIC_GAUGE_NAMES.OPEN_TRADES, 3, { status: 'OPEN' });
      service.setGauge(METRIC_GAUGE_NAMES.OPEN_TRADES, 2, { status: 'RECONCILIATION_PENDING' });
      service.setGauge(METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE, 9);
      expect(service.snapshot().gauges).toHaveLength(3);

      service.removeGauge(METRIC_GAUGE_NAMES.OPEN_TRADES);
      const snapshot = service.snapshot();
      expect(snapshot.gauges).toEqual([
        { name: METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE, labels: {}, value: 9 },
      ]);
    });

    it('ignores non-finite gauge values and never throws', () => {
      expect(() =>
        service.setGauge(METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE, Number.NaN),
      ).not.toThrow();
      expect(service.snapshot().gauges).toEqual([]);
    });
  });

  describe('snapshot()', () => {
    it('is deterministically sorted by name then label series', () => {
      service.increment('zzz_counter');
      service.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, { outcome: 'B' });
      service.increment(METRIC_NAMES.AI_SIGNALS_RECEIVED, { outcome: 'A' });
      service.increment('aaa_counter');
      const snapshot = service.snapshot();
      expect(snapshot.counters.map((c) => c.name)).toEqual([
        'aaa_counter',
        METRIC_NAMES.AI_SIGNALS_RECEIVED,
        METRIC_NAMES.AI_SIGNALS_RECEIVED,
        'zzz_counter',
      ]);
      expect(snapshot.counters[1].labels.outcome).toBe('A');
      expect(snapshot.counters[2].labels.outcome).toBe('B');
      expect(snapshot.generatedAt).toEqual(expect.any(String));
      expect(new Date(snapshot.generatedAt).getTime()).not.toBeNaN();
    });

    it('returns copies — mutating a snapshot never mutates registry state', () => {
      service.increment(METRIC_NAMES.GRANTS_ISSUED, { scope: 'x' });
      const snapshot = service.snapshot();
      snapshot.counters[0].labels.scope = 'mutated';
      snapshot.counters[0].value = 999;
      const fresh = service.snapshot();
      expect(fresh.counters[0].labels.scope).toBe('x');
      expect(fresh.counters[0].value).toBe(1);
    });
  });

  describe('recent-increment ring buffer (debugging aid)', () => {
    it('records recent increments with name/labels/value', () => {
      service.increment(METRIC_NAMES.GRANTS_CONSUMED, { reason: 'consumed' }, 2);
      const [entry] = service.snapshot().recent;
      expect(entry.name).toBe(METRIC_NAMES.GRANTS_CONSUMED);
      expect(entry.labels).toEqual({ reason: 'consumed' });
      expect(entry.value).toBe(2);
      expect(new Date(entry.at).getTime()).not.toBeNaN();
    });

    it(`is bounded at ${RECENT_INCREMENT_LIMIT} entries (oldest dropped)`, () => {
      for (let i = 0; i < RECENT_INCREMENT_LIMIT + 40; i++) {
        service.increment(METRIC_NAMES.DISPATCH_ATTEMPTS, { seq: i });
      }
      const { recent } = service.snapshot();
      expect(recent).toHaveLength(RECENT_INCREMENT_LIMIT);
      expect(recent[0].labels.seq).toBe(String(40));
      expect(recent[recent.length - 1].labels.seq).toBe(String(RECENT_INCREMENT_LIMIT + 39));
    });

    it('excludes gauge writes from the increment buffer', () => {
      service.setGauge(METRIC_GAUGE_NAMES.LIVE_SESSIONS_ACTIVE, 1);
      expect(service.snapshot().recent).toEqual([]);
    });
  });

  describe('reset()', () => {
    it('clears counters, gauges and the ring buffer', () => {
      service.increment(METRIC_NAMES.RISK_REJECTIONS, { code: 'X' });
      service.setGauge(METRIC_GAUGE_NAMES.OPEN_TRADES, 1, { status: 'OPEN' });
      service.reset();
      const snapshot = service.snapshot();
      expect(snapshot.counters).toEqual([]);
      expect(snapshot.gauges).toEqual([]);
      expect(snapshot.recent).toEqual([]);
    });
  });

  describe('METRIC_NAMES catalog (audit R7-audit-C A6 coverage)', () => {
    it('contains every counter the audit finding demands', () => {
      const required = [
        'ai_signals_received',
        'intents_created',
        'intents_rejected',
        'intents_expired',
        'sizing_failures',
        'allocation_failures',
        'risk_approvals',
        'risk_rejections',
        'grants_issued',
        'grants_consumed',
        'grants_expired',
        'dispatch_attempts',
        'dispatch_blocks',
        'provider_acknowledgements',
        'provider_rejects',
        'ambiguous_provider_outcomes',
        'reconciliation_cycles',
        'reconciliation_discrepancies',
        'duplicate_suppressions',
        'live_sessions',
        'emergency_control_activations',
        'kill_switch_flattens',
      ];
      expect(Object.values(METRIC_NAMES)).toEqual(expect.arrayContaining(required));
    });

    it('exposes unique snake_case names plus the DB-backed / last-value gauges', () => {
      const names = Object.values(METRIC_NAMES);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      }
      expect(Object.values(METRIC_GAUGE_NAMES)).toEqual([
        'irexpro_live_sessions_active',
        'irexpro_open_trades',
        'irexpro_broker_health_last_success_epoch_seconds',
        'irexpro_provider_dispatch_duration_seconds',
        'irexpro_kill_switches_active',
        'irexpro_broker_connections',
        'irexpro_broker_snapshot_staleness_seconds',
        'irexpro_reconciliation_last_cycle_age_seconds',
        'irexpro_reconciliation_pending_orders',
        'irexpro_ai_model_info',
      ]);
    });
  });
});
