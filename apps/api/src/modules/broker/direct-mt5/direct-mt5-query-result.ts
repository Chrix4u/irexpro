export function unwrapPostgresMutationRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];

  // TypeORM's PostgreSQL driver returns [rows, rowCount] for top-level
  // UPDATE/DELETE statements, including UPDATE ... RETURNING. SELECT and
  // INSERT ... RETURNING results are returned as the row array directly.
  if (
    result.length === 2 &&
    Array.isArray(result[0]) &&
    (typeof result[1] === 'number' || result[1] === null)
  ) {
    return result[0] as T[];
  }

  return result as T[];
}
