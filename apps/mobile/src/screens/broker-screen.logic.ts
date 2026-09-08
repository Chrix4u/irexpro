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
  BrokerRegistryEntry,
  CreateBrokerConnectionRequest,
} from "@irexpro/types";

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
 * Production-LIVE selection gate (architect Phase I / registry Phase H).
 *
 * The environment selector may offer LIVE ONLY when the server registry
 * BOTH declares the LIVE environment AND carries VERIFIED production-LIVE
 * evidence (`productionLiveVerification.status === 'VERIFIED'`). BETA and
 * UNVERIFIED providers (and entries whose verification payload is absent —
 * older cached wire data) fail closed: DEMO stays their only option.
 *
 * No client-side overrides, no hard-coded broker exceptions — the server
 * registry is the single source of release-truth (Directive §AU).
 */
export function isLiveSelectable(entry: BrokerRegistryEntry): boolean {
  return (
    entry.environments.includes("LIVE") &&
    entry.productionLiveVerification?.status === "VERIFIED"
  );
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
 * validated against the entry's supported environments (fail-closed).
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
