/**
 * verify-live-certification-catalog-transition.ts — transition verifier CLI
 * (Phase 3 / PLC-impl-cert-cli).
 *
 * Usage:
 *   pnpm --filter @irexpro/api run cert:verify-transition -- --evidence <path-to-artifact.json> [--broker <id>]
 *
 * Independently re-verifies a durable LIVE-certification evidence artifact
 * and checks the CURRENT broker catalog entry
 * (apps/api/src/modules/broker/registry/broker-catalog.ts) against it:
 *
 *   1. Reads the artifact, recomputes the canonical evidence SHA-256 exactly
 *      the way the harness does (computeLiveCertificationEvidenceSha256 over
 *      the parsed record) and compares it to the artifact's own
 *      evidenceSha256 — catching tampered/corrupted artifacts.
 *   2. Confirms the run identity (runId), overall result (PASS) and durable
 *      persistence state (PERSISTED) using the harness's own
 *      isCertifiablePass predicate.
 *   3. Compares the catalog entry's productionLiveVerification against the
 *      artifact:
 *      - not yet HARNESS_CERTIFIED → prints the EXACT transition values and
 *        exits 0 with status TRANSITION_PENDING (the honest pre-transition
 *        state — the manual reviewed catalog edit has not happened yet);
 *      - claims HARNESS_CERTIFIED → every field (verifiedAt, sanitized
 *        evidenceRef, certificationRunRef = <runId>@sha256:<hash>) is
 *        verified against the artifact; ANY mismatch exits non-zero with a
 *        precise error (this catches fabricated or stale catalog claims).
 *
 * The catalog is only READ here — this tool never edits anything. The only
 * legitimate transition remains the manual, reviewed edit of broker-catalog.ts
 * (see docs/brokers/live-certification-runbook.md and
 * docs/brokers/production-live-certification.md §4).
 *
 * Structure note: verifyCatalogTransitionAgainstEvidence() and
 * parseVerifyTransitionArgs() are PURE exported functions (tested by the CLI
 * spec without any file I/O); main() is the only side-effecting path and is
 * guarded by `require.main === module`.
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import {
  LiveCertificationEvidence,
  LiveCertificationRunRecord,
  computeLiveCertificationEvidenceSha256,
  isCertifiablePass,
} from '../src/modules/broker/verification/provider-live-certification-harness';
import { BROKER_CATALOG } from '../src/modules/broker/registry/broker-catalog';
import { BrokerDefinition } from '../src/modules/broker/registry/broker-definition';
import {
  buildCertificationCatalogEvidenceRef,
  buildCertificationRunRef,
  buildCertificationVerifiedAt,
} from './run-live-certification';

/** The operator runbook this CLI points at. */
const LIVE_CERTIFICATION_RUNBOOK_PATH = 'docs/brokers/live-certification-runbook.md';

/** runId shape — the harness generates randomUUID() (v4); mirrors the catalog's runRefPattern. */
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The exact values a certifiable PASS authorizes for the reviewed manual catalog edit. */
export interface CatalogTransitionValues {
  readonly status: 'VERIFIED';
  readonly verifiedAt: string;
  readonly evidenceRef: string;
  readonly certifiedVia: 'HARNESS_CERTIFIED';
  readonly certificationRunRef: string;
}

export type CatalogTransitionStatus = 'TRANSITION_PENDING' | 'VERIFIED' | 'ERROR';

/**
 * The verification outcome. `message` is always safe to print (it carries
 * catalog/artifact references — dates, file names, hashes — never secrets).
 */
export interface CatalogTransitionResult {
  readonly status: CatalogTransitionStatus;
  /** The broker the verification ran for (null when the artifact is too malformed to tell). */
  readonly brokerId: string | null;
  readonly message: string;
  /** The exact catalog-edit values (present whenever the evidence is a certifiable PASS). */
  readonly transition?: CatalogTransitionValues;
  /** Precise problem list (ERROR only). */
  readonly problems?: readonly string[];
}

/** The minimal catalog-entry surface this verifier needs (structural — the real entry satisfies it). */
export type CatalogEntryInput = Readonly<
  Pick<BrokerDefinition, 'id' | 'productionLiveVerification'>
>;

function errorResult(
  brokerId: string | null,
  message: string,
  problems: readonly string[],
): CatalogTransitionResult {
  return { status: 'ERROR', brokerId, message, problems };
}

/**
 * PURE: independently verifies a parsed evidence record (arbitrary JSON —
 * validated defensively) and checks the catalog entry's
 * productionLiveVerification against it.
 *
 * - A malformed / tampered / non-certifiable artifact → ERROR.
 * - A certifiable PASS + a catalog entry not yet HARNESS_CERTIFIED →
 *   TRANSITION_PENDING with the exact values the operator must set.
 * - A catalog HARNESS_CERTIFIED claim → every field verified against the
 *   artifact; VERIFIED only on an exact match, ERROR on any mismatch
 *   (fabricated or stale claim).
 */
export function verifyCatalogTransitionAgainstEvidence(
  evidenceRecord: unknown,
  catalogEntry: CatalogEntryInput,
): CatalogTransitionResult {
  const record = evidenceRecord as Partial<LiveCertificationEvidence> | null | undefined;
  const brokerId = typeof record?.brokerId === 'string' && record.brokerId ? record.brokerId : null;
  const problems: string[] = [];

  // ── Artifact shape + certifiability (the harness's own predicate) ─────────
  if (!record || typeof record !== 'object') {
    return errorResult(null, 'Evidence artifact is not a JSON object.', [
      'parsed artifact is not an object',
    ]);
  }
  if (typeof record.runId !== 'string' || !RUN_ID_PATTERN.test(record.runId)) {
    problems.push(
      'runId is missing or not a UUID-v4-shaped string — the harness generates randomUUID() ' +
        'run identities; a malformed runId means this is not a genuine harness artifact.',
    );
  }
  if (!brokerId) {
    problems.push('brokerId is missing or empty.');
  }
  if (record.mode !== 'LIVE') {
    problems.push(`mode must be 'LIVE' (received: ${JSON.stringify(record.mode) ?? 'undefined'}).`);
  }
  if (typeof record.finishedAt !== 'string' || Number.isNaN(Date.parse(record.finishedAt))) {
    problems.push('finishedAt is missing or not a parseable ISO timestamp.');
  }
  if (typeof record.evidenceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.evidenceSha256)) {
    problems.push('evidenceSha256 is missing or not a 64-hex-character sha256 string.');
  }
  if (!isCertifiablePass(record as LiveCertificationEvidence)) {
    problems.push(
      `isCertifiablePass(evidence) === false — the artifact must carry certificationResult 'PASS', ` +
        `evidenceState 'PERSISTED', overall 'PASS' and a recorded artifactPath ` +
        `(received: certificationResult=${JSON.stringify(record.certificationResult) ?? 'undefined'}, ` +
        `evidenceState=${JSON.stringify(record.evidenceState) ?? 'undefined'}, ` +
        `overall=${JSON.stringify(record.overall) ?? 'undefined'}). A console-only or ` +
        'persistence-failed run certifies nothing.',
    );
  }

  // ── Independent SHA-256 re-verification (same canonical form as the harness) ──
  if (typeof record.evidenceSha256 === 'string' && /^[0-9a-f]{64}$/.test(record.evidenceSha256)) {
    const recomputed = computeLiveCertificationEvidenceSha256(record as LiveCertificationRunRecord);
    if (recomputed !== record.evidenceSha256) {
      problems.push(
        'evidence SHA-256 mismatch: recomputing the canonical hash over the artifact content ' +
          `yields ${recomputed} but the artifact claims ${record.evidenceSha256} — the artifact ` +
          'has been tampered with or corrupted since the harness wrote it.',
      );
    }
  }

  if (problems.length > 0) {
    return errorResult(
      brokerId,
      'The evidence artifact does NOT support any catalog transition — it failed independent ' +
        're-verification (see problems).',
      problems,
    );
  }

  const evidence = record as LiveCertificationEvidence;

  // ── Broker identity cross-check ────────────────────────────────────────────
  if (evidence.brokerId !== catalogEntry.id) {
    return errorResult(
      evidence.brokerId,
      'Broker identity mismatch: the evidence artifact certifies ' +
        `'${evidence.brokerId}' but the checked catalog entry is '${catalogEntry.id}'. ` +
        'A certification for one broker identity can never authorize another (per-broker ' +
        'scoping — especially strict across the cTrader family aliases).',
      [`artifact brokerId '${evidence.brokerId}' !== catalog entry id '${catalogEntry.id}'`],
    );
  }

  // ── The exact transition values this certifiable PASS authorizes ──────────
  const transition: CatalogTransitionValues = {
    status: 'VERIFIED',
    verifiedAt: buildCertificationVerifiedAt(evidence),
    evidenceRef: buildCertificationCatalogEvidenceRef(evidence),
    certifiedVia: 'HARNESS_CERTIFIED',
    certificationRunRef: buildCertificationRunRef(evidence),
  };

  const verification = catalogEntry.productionLiveVerification;
  if (
    !verification ||
    verification.status !== 'VERIFIED' ||
    verification.certifiedVia !== 'HARNESS_CERTIFIED'
  ) {
    const current =
      !verification || verification.status !== 'VERIFIED'
        ? `status '${verification?.status ?? 'UNVERIFIED (absent)'}'`
        : `status 'VERIFIED' with certifiedVia '${verification.certifiedVia ?? 'absent'}'`;
    return {
      status: 'TRANSITION_PENDING',
      brokerId: evidence.brokerId,
      message:
        `TRANSITION_PENDING — a certifiable PASS artifact exists for '${evidence.brokerId}' but the ` +
        `catalog entry is not yet HARNESS_CERTIFIED (currently ${current}). Apply the EXACT values ` +
        'below through the reviewed manual edit of broker-catalog.ts, then re-run this verifier.',
      transition,
    };
  }

  // ── HARNESS_CERTIFIED claimed — verify EVERY field against the artifact ────
  const mismatches: string[] = [];
  if (verification.verifiedAt !== transition.verifiedAt) {
    mismatches.push(
      `verifiedAt mismatch: catalog claims '${verification.verifiedAt}' but the artifact proves ` +
        `'${transition.verifiedAt}' (the run's finishedAt).`,
    );
  }
  if (verification.evidenceRef !== transition.evidenceRef) {
    mismatches.push(
      `evidenceRef mismatch: catalog claims '${verification.evidenceRef}' but the artifact's ` +
        `sanitized reference is '${transition.evidenceRef}'.`,
    );
  }
  if (verification.certificationRunRef !== transition.certificationRunRef) {
    mismatches.push(
      `certificationRunRef mismatch: catalog claims '${verification.certificationRunRef}' but the ` +
        `artifact proves '${transition.certificationRunRef}' (wrong run, wrong hash, or fabricated).`,
    );
  }
  if (mismatches.length > 0) {
    return errorResult(
      evidence.brokerId,
      'The catalog entry CLAIMS HARNESS_CERTIFIED but does NOT match the evidence artifact — ' +
        'this is a fabricated or stale certification claim. Fix the catalog entry (either apply ' +
        'the exact values below, or downgrade the entry truthfully via the §4 process in ' +
        'docs/brokers/production-live-certification.md).',
      mismatches,
    );
  }

  return {
    status: 'VERIFIED',
    brokerId: evidence.brokerId,
    message:
      'VERIFIED — the catalog entry is HARNESS_CERTIFIED with values matching the evidence ' +
      'artifact exactly (verifiedAt, sanitized evidenceRef, certificationRunRef runId@sha256).',
    transition,
  };
}

// ─── CLI argument parsing (pure) ──────────────────────────────────────────────

export interface VerifyTransitionArgs {
  readonly evidencePath?: string;
  readonly brokerId?: string;
  readonly problems: readonly string[];
}

/** PURE: parses --evidence <path> (required) and --broker <id> (optional). */
export function parseVerifyTransitionArgs(argv: readonly string[]): VerifyTransitionArgs {
  const problems: string[] = [];
  let evidencePath: string | undefined;
  let brokerId: string | undefined;
  // pnpm run forwards the `--` argument separator verbatim — strip it so the
  // flags parse the same way under pnpm, npm and a direct ts-node invocation.
  const args = argv.filter((arg) => arg !== '--');
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--evidence') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        problems.push('--evidence requires a path argument (--evidence <path-to-artifact.json>).');
      } else {
        evidencePath = value;
        i += 1;
      }
    } else if (arg.startsWith('--evidence=')) {
      evidencePath = arg.slice('--evidence='.length);
    } else if (arg === '--broker') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        problems.push('--broker requires an id argument (--broker <brokerId>).');
      } else {
        brokerId = value;
        i += 1;
      }
    } else if (arg.startsWith('--broker=')) {
      brokerId = arg.slice('--broker='.length);
    } else {
      problems.push(`unknown argument '${arg}' (supported: --evidence <path>, --broker <id>).`);
    }
  }
  if (!evidencePath) {
    problems.push(
      '--evidence <path-to-artifact.json> is required — point it at a durable ' +
        'live-certification-<brokerId>-<runId>-<timestamp>.json artifact.',
    );
  }
  return { evidencePath, brokerId, problems };
}

// ─── main (side-effecting; only runs when executed as a script) ──────────────

function printTransitionValues(transition: CatalogTransitionValues): void {
  console.log('  Exact catalog-edit values (apply ONLY via the reviewed manual edit of');
  console.log('  apps/api/src/modules/broker/registry/broker-catalog.ts):');
  console.log('  productionLiveVerification: {');
  console.log(`    status: '${transition.status}',`);
  console.log(`    verifiedAt: '${transition.verifiedAt}',`);
  console.log(`    evidenceRef: '${transition.evidenceRef}',`);
  console.log(`    certifiedVia: '${transition.certifiedVia}',`);
  console.log(`    certificationRunRef: '${transition.certificationRunRef}',`);
  console.log('  }');
}

async function main(): Promise<void> {
  const args = parseVerifyTransitionArgs(process.argv.slice(2));
  if (args.problems.length > 0 || !args.evidencePath) {
    console.error(`\n  - ${args.problems.join('\n  - ')}\n`);
    console.error(`See ${LIVE_CERTIFICATION_RUNBOOK_PATH} for the operator procedure.`);
    process.exitCode = 1;
    return;
  }

  // 1. Read + parse the artifact (independent of the harness's own write path).
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(args.evidencePath, 'utf8'));
  } catch (err) {
    console.error(
      `[cert:verify-transition] cannot read/parse the evidence artifact '${args.evidencePath}': ` +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exitCode = 1;
    return;
  }
  const record = parsed as Partial<LiveCertificationEvidence> | null | undefined;

  // 2. Filename/runId integrity: a harness-named artifact must embed its own
  //    runId (catches file/content mix-ups). Renamed copies are allowed but
  //    noted honestly.
  const fileName = basename(args.evidencePath);
  if (fileName.startsWith('live-certification-')) {
    if (typeof record?.runId !== 'string' || !fileName.includes(record.runId)) {
      console.error(
        '[cert:verify-transition] artifact file-name/runId mismatch: the file follows the ' +
          'harness naming contract but does not embed the runId its content claims — this ' +
          'looks like a mix-up between artifact files.',
      );
      process.exitCode = 1;
      return;
    }
  } else if (typeof record?.runId === 'string') {
    console.log(
      `[cert:verify-transition] note: artifact file '${fileName}' was renamed (does not follow ` +
        'the harness naming contract) — content-level verification proceeds on its own merits.',
    );
  }

  // 3. Resolve the broker identity: explicit --broker wins (and must match the
  //    artifact), otherwise the artifact's own brokerId.
  const artifactBrokerId =
    typeof record?.brokerId === 'string' && record.brokerId ? record.brokerId : undefined;
  const brokerId = args.brokerId ?? artifactBrokerId;
  if (!brokerId) {
    console.error(
      '[cert:verify-transition] the artifact carries no brokerId and no --broker was given.',
    );
    process.exitCode = 1;
    return;
  }
  if (args.brokerId && artifactBrokerId && args.brokerId !== artifactBrokerId) {
    console.error(
      `[cert:verify-transition] --broker '${args.brokerId}' does not match the artifact's own ` +
        `brokerId '${artifactBrokerId}' — a certification for one broker identity can never ` +
        'authorize another.',
    );
    process.exitCode = 1;
    return;
  }

  // 4. Load the CURRENT catalog and check the entry against the artifact.
  const catalogEntry: CatalogEntryInput | undefined = BROKER_CATALOG.find(
    (entry) => entry.id === brokerId,
  );
  if (!catalogEntry) {
    console.error(
      `[cert:verify-transition] no catalog entry found for broker '${brokerId}' — the artifact ` +
        'cannot authorize a catalog transition for an unknown broker.',
    );
    process.exitCode = 1;
    return;
  }

  const result = verifyCatalogTransitionAgainstEvidence(parsed, catalogEntry);
  console.log(
    `[cert:verify-transition] status: ${result.status} (broker: ${result.brokerId ?? 'unknown'})`,
  );
  console.log(result.message);
  if (result.problems && result.problems.length > 0) {
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }
  }
  if (result.transition) {
    printTransitionValues(result.transition);
  }
  console.log(`Operator procedure: ${LIVE_CERTIFICATION_RUNBOOK_PATH}`);

  process.exitCode = result.status === 'ERROR' ? 1 : 0;
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(
      '[cert:verify-transition] failed: ' +
        (err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
    );
    process.exitCode = 1;
  });
}
