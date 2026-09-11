/**
 * Dialect-agnostic unique-violation detection (Sprint 56 correction round 5,
 * architect issue #332).
 *
 * The idempotent-link contract keys off the database rejecting a duplicate
 * logical-account INSERT. PostgreSQL reports SQLSTATE 23505
 * (unique_violation) as `error.code`; the sqlite test harness reports
 * `SQLITE_CONSTRAINT` + a `UNIQUE constraint failed: ...` message. Both
 * shapes are recognized here so the adopt-or-conflict behavior is provable
 * on the sqlite harness and identical on production PostgreSQL.
 */

/** PostgreSQL SQLSTATE for unique_violation. */
const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; message?: unknown };
  if (typeof candidate.code === 'string' && candidate.code === PG_UNIQUE_VIOLATION) {
    return true;
  }
  const message =
    err instanceof Error
      ? err.message
      : typeof candidate.message === 'string'
        ? candidate.message
        : '';
  return (
    message.includes('UNIQUE constraint failed') ||
    message.includes('duplicate key value violates unique')
  );
}
