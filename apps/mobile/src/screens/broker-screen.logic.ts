/**
 * BrokerScreen pure presentation logic (Directive §AE/§AB).
 *
 * Extracted from the component so the catalog honesty rules, connectable
 * gating, and form derivation are unit-testable without React Native
 * (Directive §J). The component MUST use these functions rather than
 * duplicating rules.
 */
import type {
  BrokerAuthenticationType,
  BrokerAvailabilityStatus,
  BrokerConnectionRoute,
  BrokerConnectionView,
  BrokerRegistryEntry,
  CreateBrokerConnectionRequest,
} from "@irexpro/types";
import type { ProviderVerificationLabel } from "@irexpro/types/provider-verification";
import { assessProviderVerification } from "@irexpro/types/provider-verification";
import { deriveProviderCertificationState } from "@irexpro/types/broker-registry";

export interface BrokerStatusPresentation {
  label: string;
  color: string;
  /** Honest copy — never implies availability that does not exist. */
  description: string;
  /** Only adapter-backed entries may open the connect flow (§AB). */
  connectable: boolean;
}

const STATUS_PRESENTATION: Record<
  BrokerAvailabilityStatus,
  BrokerStatusPresentation
> = {
  SUPPORTED: {
    label: "Supported",
    color: "#10b981",
    description: "Fully integrated and tested.",
    connectable: true,
  },
  BETA: {
    label: "Beta",
    color: "#f59e0b",
    // Honest release-truth (Phase I/registry Phase H): BETA = implemented +
    // contract-tested. It says NOTHING about production-LIVE approval —
    // DEMO is connectable, LIVE stays server-fail-closed until VERIFIED.
    description: "Beta — implemented and contract-tested; live verification in progress.",
    connectable: true,
  },
  NOT_STARTED: {
    label: "Coming soon",
    color: "#9ca3af",
    description: "Not yet available — integration not implemented.",
    connectable: false,
  },
  PARTNER_APPROVAL_REQUIRED: {
    label: "Approval required",
    color: "#a78bfa",
    description: "Requires provider/partner approval before access.",
    connectable: false,
  },
  UNAVAILABLE: {
    label: "Unavailable",
    color: "#f43f5e",
    description: "Currently unavailable in your region or platform.",
    connectable: false,
  },
};

/** Status badge presentation — fail-closed: unknown statuses are NOT connectable. */
export function statusPresentation(
  status: BrokerAvailabilityStatus,
): BrokerStatusPresentation {
  return STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.NOT_STARTED;
}

/**
 * Connectability gate (Directive §AB fail-closed rendering): an entry is
 * connectable ONLY when the registry says an adapter is live AND its status
 * is one of the adapter-backed statuses.
 */
export function isConnectableEntry(entry: BrokerRegistryEntry): boolean {
  const presentation = statusPresentation(entry.status);
  return presentation.connectable && entry.adapterAvailable === true;
}

/**
 * Production-LIVE selection gate (architect Phase I / registry Phase H /
 * production-LIVE completion round).
 *
 * The environment selector may offer LIVE ONLY when the server registry
 * declares the LIVE environment AND the provider is CURRENTLY production-LIVE
 * eligible — i.e. the derived certification state is CERTIFIED (a complete
 * HARNESS_CERTIFIED record). Legacy attestation (LEGACY_VERIFIED), BETA and
 * UNVERIFIED providers (and entries whose payload is absent — older cached
 * wire data) all fail closed: DEMO stays their only option, because the
 * server LIVE gates reject them anyway — the UI must never offer an action
 * the server will refuse.
 *
 * No client-side overrides, no hard-coded broker exceptions — the server
 * registry is the single source of release-truth (Directive §AU).
 */
export function isLiveSelectable(entry: BrokerRegistryEntry): boolean {
  const certificationState =
    entry.certificationState ??
    deriveProviderCertificationState(entry.productionLiveVerification ?? undefined);
  return entry.environments.includes("LIVE") && certificationState === "CERTIFIED";
}

/**
 * Live-readiness reason lines for a registry entry (production-LIVE
 * completion round, Phase 15): the server-computed WHY behind a disabled
 * LIVE option — rendered BEFORE the user attempts anything. Unknown/older
 * payloads degrade to the certification-required truth.
 */
export function liveReadinessReasonLines(entry: BrokerRegistryEntry): string[] {
  const readiness = entry.liveReadiness;
  if (!readiness) {
    return ["LIVE requires a current provider certification"];
  }
  const lines: string[] = [];
  for (const reason of readiness.blockedReasons) {
    switch (reason) {
      case "LIVE_UNSUPPORTED":
        lines.push("This provider does not offer LIVE accounts");
        break;
      case "ADAPTER_UNAVAILABLE":
        lines.push("Provider integration is not currently available");
        break;
      case "PARTNER_APPROVAL_REQUIRED":
        lines.push("Partner approval required before LIVE is possible");
        break;
      case "CERTIFICATION_REQUIRED":
        lines.push("LIVE requires a current provider certification");
        break;
      default:
        lines.push("LIVE is not currently available for this provider");
    }
  }
  return lines.length > 0 ? lines : ["LIVE is not currently available for this provider"];
}

/** Key capabilities surfaced as chips (keep the catalog list readable). */
export function keyCapabilityChips(entry: BrokerRegistryEntry): string[] {
  const caps = entry.capabilities;
  const chips: string[] = [];
  if (caps.includes("DEMO")) chips.push("Demo");
  if (caps.includes("LIVE")) chips.push("Live");
  if (caps.includes("MARKET_DATA")) chips.push("Market data");
  if (caps.includes("ORDER_PLACEMENT")) chips.push("Orders");
  return chips;
}

// ── Provider verification label taxonomy (Sprint 56 correction round 5) ─────
//
// EXACTLY the six architect labels: 'LIVE-capable' | 'Production LIVE
// Verified' | 'Production LIVE Unverified' | 'Ineligible' | 'DEMO only' |
// 'execution disabled'. An UNVERIFIED BETA provider is NEVER labeled simply
// "Live" — the shared assessment maps server facts onto the fixed vocabulary
// and degrades fail-closed when a fact is missing.

/** Mobile badge color for a taxonomy label (risk-ascending). */
export function verificationLabelColor(label: ProviderVerificationLabel): string {
  switch (label) {
    case "Production LIVE Verified":
      return "#10b981";
    case "Production LIVE Unverified":
    case "execution disabled":
      return "#f43f5e";
    case "DEMO only":
    case "Ineligible":
      return "#f59e0b";
    default:
      return "#6b7280";
  }
}

/** Verification label for a catalog (registry) entry. */
export function verificationLabelForEntry(
  entry: BrokerRegistryEntry,
): ProviderVerificationLabel {
  return assessProviderVerification({
    environments: entry.environments,
    implementationStatus: entry.status,
    adapterAvailable: entry.adapterAvailable,
    productionLiveVerification: entry.productionLiveVerification ?? null,
    certificationState: entry.certificationState ?? null,
  }).label;
}

/**
 * Verification label for one user connection, joined with the registry entry
 * (by brokerId). A missing join degrades fail-closed — never toward a
 * "Live"-sounding claim.
 */
export function verificationLabelForConnection(
  connection: Pick<
    BrokerConnectionView,
    | "accountType"
    | "authorizationStatus"
    | "providerBrokerIdentity"
    | "logicalAccountKey"
  >,
  registryEntry: BrokerRegistryEntry | null,
): ProviderVerificationLabel {
  return assessProviderVerification({
    environments: registryEntry?.environments ?? null,
    implementationStatus: registryEntry?.status ?? null,
    adapterAvailable: registryEntry?.adapterAvailable ?? null,
    productionLiveVerification: registryEntry?.productionLiveVerification ?? null,
    certificationState: registryEntry?.certificationState ?? null,
    accountType: connection.accountType,
    logicalAccountKey: connection.logicalAccountKey ?? null,
    authorizationStatus: connection.authorizationStatus,
    // The broker-connection view carries no executable gate — unknown, never
    // guessed (the live-account surface renders the server gate).
    executable: null,
  }).label;
}

/** Human label for a connection route (Directive §AF). */
export function routeLabel(route: BrokerConnectionRoute): string {
  switch (route) {
    case "NATIVE_API":
      return "Direct API";
    case "CTRADER":
      return "cTrader";
    case "METATRADER":
      return "MetaTrader";
    case "FIX":
      return "FIX";
    case "SDK":
      return "Provider SDK";
    case "PAPER":
      return "Paper";
    default:
      return "Unknown route";
  }
}

export interface CredentialFieldRequirement {
  /** API token field (API_TOKEN auth) — typed secret, never echoed back. */
  apiKey: boolean;
  /** Secret field (some API_TOKEN providers use both). */
  apiSecret: boolean;
  /** Free-text server URL (optional for most providers). */
  serverUrl: boolean;
}

/** Which credential inputs the connect form needs for an auth model. */
export function credentialFields(
  authType: BrokerAuthenticationType,
): CredentialFieldRequirement {
  switch (authType) {
    case "API_TOKEN":
      return { apiKey: true, apiSecret: false, serverUrl: false };
    case "OAUTH":
      // OAuth brokers authorize out-of-band — only the account id is typed.
      return { apiKey: false, apiSecret: false, serverUrl: false };
    case "SESSION_AUTH":
      return { apiKey: true, apiSecret: false, serverUrl: true };
    default:
      // Unknown auth model: request the token + secret conservatively.
      return { apiKey: true, apiSecret: true, serverUrl: false };
  }
}

/**
 * Build the create/test request body from form state. The environment is
 * validated against the entry's supported environments and the independent
 * production-LIVE verification gate (fail-closed even if a stale/direct caller
 * bypasses the selector UI).
 */
export function buildConnectionRequest(
  entry: BrokerRegistryEntry,
  environment: "DEMO" | "LIVE",
  accountId: string,
  apiKey: string,
): CreateBrokerConnectionRequest | { error: string } {
  if (!entry.environments.includes(environment)) {
    return { error: `${entry.name} does not support ${environment} accounts` };
  }
  if (environment === "LIVE" && !isLiveSelectable(entry)) {
    return {
      error: `${entry.name} is not production-verified for LIVE accounts`,
    };
  }
  if (accountId.trim().length === 0) {
    return { error: "Account ID is required" };
  }
  if (entry.authenticationType === "API_TOKEN" && apiKey.trim().length === 0) {
    return { error: "API token is required for this broker" };
  }
  return {
    brokerId: entry.id,
    accountType: environment,
    accountId: accountId.trim(),
    ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
  };
}
