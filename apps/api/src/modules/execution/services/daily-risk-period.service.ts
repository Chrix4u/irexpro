import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DailyRiskPeriod } from '../entities/daily-risk-period.entity';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import { isUniqueViolation } from '../../broker/utils/db-unique-violation';

/**
 * DailyRiskPeriodService — the durable per-day loss budget authority (Sprint
 * 56 correction round 6, architect issues #362/#313).
 *
 * POLICY (documented per the architect brief, issue #362)
 * ─────────────────────────────────────────────────────
 *  - DAY BOUNDARY: the trading day is the UTC calendar day
 *    ('YYYY-MM-DD' from utcDayKey). No local timezone, no per-broker
 *    midnight, and NEVER the user's preferred UI currency/locale.
 *
 *  - BUDGET SCOPE: one DailyRiskPeriod per (userId, logicalAccountKey,
 *    riskPeriodDate) — enforced by a database unique constraint. The daily
 *    loss budget is therefore bound to the LOGICAL BROKER ACCOUNT, not to a
 *    TradingSession: restarting/ending/restarting a session can NEVER reset
 *    the day's loss budget for the same economic account. Resolving the same
 *    scope twice returns the SAME row with the ORIGINAL baseline.
 *
 *  - BASELINE: openingBalance/openingEquity come EXACTLY from the FIRST
 *    trusted broker-account snapshot of the day (decimal strings, never
 *    floats); the snapshot's id is persisted as immutable lineage
 *    (openingSnapshotId) together with the risk-profile lineage
 *    (riskProfileId/riskProfileRevision). A baseline that is absent or
 *    malformed fails closed (DailyRiskPeriodBaselineError) — it is never
 *    defaulted and never guessed.
 *
 *  - CURRENCY: the period pins ONE account currency for the logical account
 *    for the whole day. A later resolution with a different currency for the
 *    same logical account + day is a typed fail-closed conflict
 *    (DailyRiskPeriodCurrencyMismatchError) — heterogeneous currencies are
 *    NEVER raw-summed into one budget. Any future portfolio-level limit that
 *    must combine currencies requires an explicit timestamped trusted FX
 *    conversion authority (out of scope here by design).
 *
 *  - REALISED LOSS MEASUREMENT (getTodayRealisedLossExact): the NET realised
 *    P&L of CLOSED losing trades of the logical account + currency since UTC
 *    day start. Commissions and swap/financing charges are EMBEDDED in the
 *    provider-reported realised_pnl — they are not added on top and not
 *    subtracted again. Deposits and withdrawals are BALANCE EVENTS, not trade
 *    P&L: they never enter this sum (they affect equity, which is why the
 *    daily-loss budget is measured on trade P&L against the opening
 *    snapshot baseline, not on balance deltas).
 *
 *  - EXACT ARITHMETIC (issue #313): the SQL SUM is returned as a RAW string
 *    (PostgreSQL NUMERIC). There is ZERO parseFloat/Number/unary conversion
 *    on the money path — consumers must compare with ExactDecimal. (The
 *    sqlite mirror harness's SUM returns an IEEE double purely because of the
 *    mirror's numeric affinity; the harness-only branch converts that double
 *    back to its shortest round-trip string. Production PostgreSQL never
 *    takes that branch.)
 *
 *  - LEGACY DATA: trades without immutable provenance
 *    (logical_account_key IS NULL OR account_currency IS NULL) are NOT
 *    guessed into any scope. They are excluded from the scoped total, and
 *    their presence among today's losing trades marks the result
 *    complete=false so LIVE risk decisions can fail closed (issue #362:
 *    "rows without provable currency/session/account provenance must not be
 *    guessed").
 */
@Injectable()
export class DailyRiskPeriodService {
  private readonly logger = new Logger(DailyRiskPeriodService.name);

  constructor(
    @InjectRepository(DailyRiskPeriod)
    private readonly periodRepo: Repository<DailyRiskPeriod>,
    private readonly dataSource: DataSource,
  ) {}

  /** UTC calendar day key 'YYYY-MM-DD' (the trading-day boundary policy). */
  utcDayKey(now?: Date): string {
    const d = now ?? new Date();
    return d.toISOString().slice(0, 10);
  }

  /**
   * Resolve (get-or-create) the DailyRiskPeriod for
   * (userId, logicalAccountKey, UTC day of `now`).
   *
   *  - Existing row → returned as-is: the baseline NEVER resets, so a session
   *    restart (or any number of re-resolutions with different snapshots)
   *    keeps the day's original budget. A different accountCurrency for the
   *    same scope is a typed fail-closed mismatch.
   *  - Missing row → created with the EXACT snapshot baseline + lineage.
   *  - Concurrent creation → the database unique constraint elects ONE
   *    winner; the loser re-reads and returns the winner's row (never a
   *    second budget, never a reset).
   */
  async resolveDailyRiskPeriod(input: {
    userId: string;
    brokerConnectionId: string;
    logicalAccountKey: string;
    accountCurrency: string;
    snapshot: { id: string; balance: string; equity: string };
    riskProfile?: { id: string; revision: number } | null;
    now?: Date;
  }): Promise<DailyRiskPeriod> {
    this.assertTrustworthyBaseline(input);

    const now = input.now ?? new Date();
    const riskPeriodDate = this.utcDayKey(now);

    const existing = await this.periodRepo.findOne({
      where: {
        userId: input.userId,
        logicalAccountKey: input.logicalAccountKey,
        riskPeriodDate,
      },
    });
    if (existing) {
      this.assertCurrencyMatches(existing, input.accountCurrency);
      return existing;
    }

    try {
      return await this.periodRepo.save(
        this.periodRepo.create({
          userId: input.userId,
          brokerConnectionId: input.brokerConnectionId,
          logicalAccountKey: input.logicalAccountKey,
          accountCurrency: input.accountCurrency,
          riskPeriodDate,
          openingBalance: input.snapshot.balance,
          openingEquity: input.snapshot.equity,
          openingSnapshotId: input.snapshot.id,
          riskProfileId: input.riskProfile?.id ?? null,
          riskProfileRevision: input.riskProfile?.revision ?? null,
        }),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Concurrent creation won the (userId, logicalAccountKey, day) slot.
      // Re-read the winner — the budget is singular and never resets.
      this.logger.warn(
        `Concurrent DailyRiskPeriod creation for user ${input.userId}, logical account ` +
          `${input.logicalAccountKey}, day ${riskPeriodDate} — converging on the winner`,
      );
      const winner = await this.periodRepo.findOne({
        where: {
          userId: input.userId,
          logicalAccountKey: input.logicalAccountKey,
          riskPeriodDate,
        },
      });
      if (!winner) throw err;
      this.assertCurrencyMatches(winner, input.accountCurrency);
      return winner;
    }
  }

  /**
   * Today's realised loss for (userId, logicalAccountKey, accountCurrency) —
   * NET realised P&L of CLOSED losing trades since UTC day start, as a RAW
   * decimal string (never a float). `complete=false` reports that legacy
   * NULL-provenance losing trades exist today for the user (rows without an
   * immutable logical_account_key/account_currency): they are excluded from
   * the scoped total and LIVE risk decisions must fail closed on them.
   */
  async getTodayRealisedLossExact(input: {
    userId: string;
    logicalAccountKey: string;
    accountCurrency: string;
    now?: Date;
  }): Promise<{ total: string; complete: boolean }> {
    const now = input.now ?? new Date();
    const dayStartIso = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();

    const sumRows: Array<{ total: string | number | null }> = await this.dataSource.query(
      `SELECT COALESCE(SUM(realised_pnl), 0) AS total
       FROM ${this.tradesTableName()}
       WHERE user_id = $1
         AND logical_account_key = $2
         AND account_currency = $3
         AND status = 'CLOSED'
         AND closed_at >= $4
         AND realised_pnl < 0`,
      [input.userId, input.logicalAccountKey, input.accountCurrency, dayStartIso],
    );
    const rawTotal = sumRows[0]?.total;
    const total =
      typeof rawTotal === 'number'
        ? this.harnessNumberToExactString(rawTotal)
        : String(rawTotal ?? '0');

    // Legacy NULL-provenance losers today (user-scoped only — the rows lack
    // the logical account key by definition). Their existence makes the
    // measurement incomplete: consumers must fail closed for LIVE decisions.
    const legacyRows: Array<{ n: number | string }> = await this.dataSource.query(
      `SELECT COUNT(*) AS n
       FROM ${this.tradesTableName()}
       WHERE user_id = $1
         AND status = 'CLOSED'
         AND closed_at >= $2
         AND realised_pnl < 0
         AND (logical_account_key IS NULL OR account_currency IS NULL)`,
      [input.userId, dayStartIso],
    );
    const complete = Number(legacyRows[0]?.n ?? 0) === 0;

    return { total, complete };
  }

  // ─── Protected seams (test override points) ────────────────────────────────

  /**
   * Production trades table — EXACTLY 'trading.trades' (schema-qualified).
   * The sqlite mirror harness registers the trades mirror UNQUALIFIED (sqlite
   * has no schemas), so specs override this seam with the mirror table name.
   */
  protected tradesTableName(): string {
    return 'trading.trades';
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Harness-only conversion of the sqlite mirror's IEEE-double SUM back to a
   * string. Production PostgreSQL returns NUMERIC as an exact string and
   * never reaches this branch; the conversion uses the shortest round-trip
   * decimal form of the double (no parseFloat, no arithmetic).
   */
  private harnessNumberToExactString(value: number): string {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Non-finite SUM result from the trades table — refusing to approximate: ${value}`,
      );
    }
    return String(value);
  }

  /** Fail-closed validation of everything the baseline is built from. */
  private assertTrustworthyBaseline(input: {
    userId: string;
    logicalAccountKey: string;
    accountCurrency: string;
    snapshot: { id: string; balance: string; equity: string };
  }): void {
    if (!input.userId) {
      throw new DailyRiskPeriodBaselineError('userId is required');
    }
    if (!input.logicalAccountKey || typeof input.logicalAccountKey !== 'string') {
      throw new DailyRiskPeriodBaselineError(
        `logicalAccountKey must be a non-empty string (got "${String(input.logicalAccountKey)}")`,
      );
    }
    if (!/^[A-Z]{3}$/.test(input.accountCurrency)) {
      throw new DailyRiskPeriodBaselineError(
        `accountCurrency must be a 3-letter uppercase ISO code (got "${String(input.accountCurrency)}")`,
      );
    }
    if (!input.snapshot || !input.snapshot.id) {
      throw new DailyRiskPeriodBaselineError('a trusted snapshot id is required for the baseline');
    }
    if (!ExactDecimal.tryParse(input.snapshot.balance)) {
      throw new DailyRiskPeriodBaselineError(
        `snapshot balance is not an exact decimal: "${String(input.snapshot?.balance)}"`,
      );
    }
    if (!ExactDecimal.tryParse(input.snapshot.equity)) {
      throw new DailyRiskPeriodBaselineError(
        `snapshot equity is not an exact decimal: "${String(input.snapshot?.equity)}"`,
      );
    }
  }

  /** The period pins ONE currency per logical account per day. */
  private assertCurrencyMatches(existing: DailyRiskPeriod, requested: string): void {
    if (existing.accountCurrency !== requested) {
      throw new DailyRiskPeriodCurrencyMismatchError({
        logicalAccountKey: existing.logicalAccountKey,
        riskPeriodDate: existing.riskPeriodDate,
        existingCurrency: existing.accountCurrency,
        requestedCurrency: requested,
      });
    }
  }
}

/** The daily baseline is not trustworthy — fail closed, never guess. */
export class DailyRiskPeriodBaselineError extends Error {
  constructor(detail: string) {
    super(`Daily risk period baseline is not trustworthy: ${detail}`);
    this.name = 'DailyRiskPeriodBaselineError';
  }
}

/**
 * The logical account's day is already pinned to a different currency —
 * heterogeneous currencies are never raw-summed into one budget.
 */
export class DailyRiskPeriodCurrencyMismatchError extends Error {
  constructor(details: {
    logicalAccountKey: string;
    riskPeriodDate: string;
    existingCurrency: string;
    requestedCurrency: string;
  }) {
    super(
      `Daily risk period currency mismatch for logical account "${details.logicalAccountKey}" ` +
        `on ${details.riskPeriodDate}: existing period is ${details.existingCurrency}, ` +
        `requested ${details.requestedCurrency}. Heterogeneous currencies are never ` +
        `raw-summed — resolve the correct account or an explicit trusted FX authority.`,
    );
    this.name = 'DailyRiskPeriodCurrencyMismatchError';
  }
}
