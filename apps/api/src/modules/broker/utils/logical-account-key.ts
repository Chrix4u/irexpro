import { CTRADER_FAMILY_BROKER_IDS } from '../registry/broker-catalog';

/**
 * Durable logical broker-account identity (Sprint 56 correction round 5,
 * architect issue #332 — P0: durable idempotent OAuth connection linking).
 *
 * A BrokerConnection row is made IDEMPOTENT-KEYED by a SERVER-COMPUTED
 * logical account key:
 *
 *   `<providerTechnology>|<normalizedProviderIdentity|brokerId>|<accountId>`
 *
 * persisted in broker.broker_connections.logical_account_key and enforced
 * per-user by the partial unique index
 * `uq_broker_connections_logical_account ON (user_id, logical_account_key)
 * WHERE deleted_at IS NULL AND logical_account_key IS NOT NULL`
 * (migration 1754050000000).
 *
 * Design properties (mirrored 1:1 by the migration's backfill):
 * - TECHNOLOGY canonicalization: every cTrader-family broker id
 *   (ctrader / pepperstone-ctrader / icmarkets-ctrader) normalizes to
 *   'ctrader' — the same provider account cannot become duplicable merely by
 *   selecting a different catalog alias.
 * - IDENTITY: the server-derived provider identity (normalized discovery
 *   brand, e.g. 'pepperstone') when known, else the broker id. Two aliases
 *   linking the SAME discovered account therefore derive the SAME key.
 * - NULL = insufficient evidence (no provider account reference): the row is
 *   excluded from the uniqueness scope until evidence exists — exactly the
 *   migration backfill's `WHERE account_id IS NOT NULL AND account_id <> ''`.
 * - SERVER-ONLY: the key is computed from server-side facts (broker id,
 *   provider discovery, provider account reference) — clients can never
 *   submit or overwrite it (the public ConnectBrokerDto has no such field).
 */

/** Canonical technology for the cTrader family (all catalog aliases). */
export const CTRADER_LOGICAL_TECHNOLOGY = 'ctrader';

/** Explicit technology canonicalization for known non-cTrader broker ids. */
const CANONICAL_TECHNOLOGY_BY_BROKER_ID: Readonly<Record<string, string>> = {
  metatrader5: 'metatrader5',
  oanda: 'oanda',
  'paper-broker': 'paper-broker',
};

/**
 * Canonical adapter technology for a broker id — the first component of the
 * logical account key. Matches the migration backfill CASE expression
 * exactly:
 *   ctrader / pepperstone-ctrader / icmarkets-ctrader → 'ctrader'
 *   metatrader5 → 'metatrader5'; oanda → 'oanda'; paper-broker → 'paper-broker'
 *   unknown ids → the id itself (fail-closed: never guessed).
 */
export function canonicalAdapterTechnology(brokerId: string): string {
  if (CTRADER_FAMILY_BROKER_IDS.includes(brokerId)) {
    return CTRADER_LOGICAL_TECHNOLOGY;
  }
  return CANONICAL_TECHNOLOGY_BY_BROKER_ID[brokerId] ?? brokerId;
}

/**
 * Computes the durable logical account key
 * `${technology}|${identity}|${account}`:
 * - technology  = canonicalAdapterTechnology(brokerId);
 * - identity    = providerBrokerIdentity (when the server derived one) else
 *                 the broker id itself;
 * - account     = the provider-side account reference (stringified).
 *
 * Returns NULL when there is no provider account evidence — the caller
 * persists NULL and the partial unique index excludes the row (insufficient
 * evidence must NEVER fabricate a key).
 */
export function computeLogicalAccountKey(
  brokerId: string,
  providerBrokerIdentity: string | null | undefined,
  providerAccountId: string | number | null | undefined,
): string | null {
  const account =
    providerAccountId === null || providerAccountId === undefined
      ? ''
      : String(providerAccountId).trim();
  if (account === '') return null;
  const identity =
    providerBrokerIdentity !== null &&
    providerBrokerIdentity !== undefined &&
    providerBrokerIdentity.trim() !== ''
      ? providerBrokerIdentity
      : brokerId;
  return `${canonicalAdapterTechnology(brokerId)}|${identity}|${account}`;
}
