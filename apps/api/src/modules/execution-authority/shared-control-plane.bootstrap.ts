import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { SharedControlRevisionService } from './shared-control-revision.service';
import { EligibilityService } from '../users/eligibility.service';
import { BROKER_CATALOG, BROKER_CATALOG_VERSION } from '../broker/registry/broker-catalog';

/**
 * Round 6 (#363): canonical SHA-256 fingerprint of the EMBEDDED provider
 * LIVE-verification catalog (broker id + operator-attested verification state
 * + catalog version, canonically ordered). The bootstrap compares it against
 * the shared durable revision state: same fingerprint ⇒ no-op; different ⇒
 * append-only revision advance. Downgrades and upgrades both advance.
 */
export function computeProviderCatalogFingerprint(): string {
  const payload = {
    catalogVersion: BROKER_CATALOG_VERSION,
    entries: BROKER_CATALOG.map((entry) => ({
      brokerId: entry.id,
      liveVerification: entry.productionLiveVerification,
    })).sort((left, right) => left.brokerId.localeCompare(right.brokerId)),
  };
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

/**
 * SharedControlPlaneBootstrap — Round 6 (#363): deployment-time sync of the
 * shared cross-replica control plane.
 *
 * On EVERY boot (OnModuleInit) the embedded authority sources are compared
 * against the durable shared state:
 *
 *   - the ACTIVE eligibility/trading policy fingerprint (EligibilityService —
 *     jurisdiction sets + versioned disclosures);
 *   - the embedded provider LIVE-verification catalog fingerprint (BROKER_CATALOG).
 *
 * Outcomes (per singleton, monotonic — see SharedControlRevisionService):
 *   never-seeded ⇒ seed revision 1 + fingerprint + revision-1 log row;
 *   same fingerprint ⇒ no-op (this replica is current);
 *   different fingerprint ⇒ append-only log row + revision-guarded CAS
 *   advance — so during a rolling deployment, a stale replica's grant
 *   bindings (tradingPolicyRevision / providerVerificationRevision) mismatch
 *   the advanced shared revision and the final-dispatch commitment FAILS
 *   CLOSED for NEW exposure (§16: a stale replica must never execute).
 *
 * Failure semantics: a bootstrap sync FAILURE is FATAL for the process — the
 * shared control plane is a NEW-exposure precondition, and continuing without
 * it would let this replica serve unversioned authority (fail-closed boot).
 */
@Injectable()
export class SharedControlPlaneBootstrap implements OnModuleInit {
  private readonly logger = new Logger(SharedControlPlaneBootstrap.name);

  constructor(
    private readonly sharedControlRevisions: SharedControlRevisionService,
    private readonly eligibility: EligibilityService,
  ) {}

  async onModuleInit(): Promise<void> {
    const policy = this.eligibility.getActivePolicyFingerprint();
    const policyRevision = await this.sharedControlRevisions.syncTradingPolicy(
      policy.fingerprint,
      `embedded trading policy v${policy.version} deployed`,
    );
    this.logger.log(
      `Shared trading-policy revision synced: revision=${policyRevision} ` +
        `(policy v${policy.version}, fingerprint=${policy.fingerprint.slice(0, 12)}…)`,
    );

    const catalogFingerprint = computeProviderCatalogFingerprint();
    const catalogRevision = await this.sharedControlRevisions.syncProviderVerificationCatalog(
      catalogFingerprint,
      `embedded provider verification catalog ${BROKER_CATALOG_VERSION} deployed`,
    );
    this.logger.log(
      `Shared provider-verification revision synced: revision=${catalogRevision} ` +
        `(catalog ${BROKER_CATALOG_VERSION}, fingerprint=${catalogFingerprint.slice(0, 12)}…)`,
    );
  }
}
