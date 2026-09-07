const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate externally supplied UUID-shaped identity claims before they reach a
 * PostgreSQL uuid predicate. Valid values are normalized to lowercase so every
 * authentication channel uses one canonical representation.
 */
export function normalizeCanonicalUuid(value: unknown): string | null {
  if (typeof value !== 'string' || !CANONICAL_UUID_PATTERN.test(value)) {
    return null;
  }
  return value.toLowerCase();
}
