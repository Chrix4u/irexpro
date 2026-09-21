/**
 * BrokerScreen logic tests (Directive §J — catalog honesty + connect gating).
 */
import type { BrokerRegistryEntry } from "@irexpro/types";
import {
  buildConnectionRequest,
  credentialFields,
  isConnectableEntry,
  isLiveSelectable,
  liveReadinessReasonLines,
  keyCapabilityChips,
  routeLabel,
  statusPresentation,
} from "../broker-screen.logic";

const entry = (
  overrides: Partial<BrokerRegistryEntry>,
): BrokerRegistryEntry => ({
  id: "oanda",
  name: "OANDA",
  description: "",
  status: "BETA",
  connectionRoutes: ["NATIVE_API"],
  capabilities: [
    "ACCOUNT_READ",
    "ORDER_PLACEMENT",
    "MARKET_DATA",
    "DEMO",
    "LIVE",
  ],
  authenticationType: "API_TOKEN",
  environments: ["DEMO", "LIVE"],
  regions: [],
  adapterAvailable: true,
  ...overrides,
});

describe("statusPresentation (§AB honesty)", () => {
  it("marks adapter-backed statuses connectable", () => {
    expect(statusPresentation("SUPPORTED").connectable).toBe(true);
    expect(statusPresentation("BETA").connectable).toBe(true);
  });

  it("BETA copy is honest release-truth (Phase I): contract-tested, live verification in progress", () => {
    expect(statusPresentation("BETA").description).toBe(
      "Beta — implemented and contract-tested; live verification in progress.",
    );
  });

  it("marks non-implemented statuses NOT connectable with honest copy", () => {
    expect(statusPresentation("NOT_STARTED").connectable).toBe(false);
    expect(statusPresentation("PARTNER_APPROVAL_REQUIRED").connectable).toBe(
      false,
    );
    expect(statusPresentation("UNAVAILABLE").connectable).toBe(false);
    expect(statusPresentation("NOT_STARTED").description).toContain(
      "Not yet available",
    );
  });
});

describe("isConnectableEntry (fail-closed gating)", () => {
  it("connects only when adapter is live AND status allows", () => {
    expect(isConnectableEntry(entry({}))).toBe(true);
    expect(isConnectableEntry(entry({ adapterAvailable: false }))).toBe(false);
    expect(isConnectableEntry(entry({ status: "NOT_STARTED" }))).toBe(false);
    expect(
      isConnectableEntry(
        entry({ status: "PARTNER_APPROVAL_REQUIRED", adapterAvailable: false }),
      ),
    ).toBe(false);
  });
});

describe("isLiveSelectable (Phase I — production-LIVE release-truth)", () => {
  it("BETA/UNVERIFIED entries never offer LIVE (DEMO-only)", () => {
    expect(
      isLiveSelectable(
        entry({
          status: "BETA",
          productionLiveVerification: {
            status: "UNVERIFIED",
            verifiedAt: null,
            evidenceRef: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("legacy VERIFIED evidence does NOT offer LIVE — only a CERTIFIED provider does (Phase 2 truth fix)", () => {
    // metatrader5's shape: raw status VERIFIED with LEGACY_ATTESTATION
    // provenance and no harness run. The server LIVE gate rejects it, so the
    // mobile selector must not offer it.
    expect(
      isLiveSelectable(
        entry({
          productionLiveVerification: {
            status: "VERIFIED",
            verifiedAt: "2025-09-01T00:00:00.000Z",
            evidenceRef: "docs/brokers/provider-matrix.md",
            certifiedVia: "LEGACY_ATTESTATION",
            certificationRunRef: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it("a complete CERTIFIED (HARNESS_CERTIFIED) provider with LIVE environment offers LIVE", () => {
    expect(
      isLiveSelectable(
        entry({
          productionLiveVerification: {
            status: "VERIFIED",
            verifiedAt: "2026-09-01T00:00:00.000Z",
            evidenceRef: "ops/live-certification/2026-09-01",
            certifiedVia: "HARNESS_CERTIFIED",
            certificationRunRef:
              "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d@sha256:" +
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
        }),
      ),
    ).toBe(true);
  });

  it("an explicit server certificationState CERTIFIED offers LIVE even on older payload shapes", () => {
    expect(
      isLiveSelectable(
        entry({
          certificationState: "CERTIFIED",
        }),
      ),
    ).toBe(true);
  });

  it("liveReadinessReasonLines renders the server's blocked reasons before the user attempts anything", () => {
    expect(
      liveReadinessReasonLines(
        entry({
          liveReadiness: {
            eligible: false,
            blockedReasons: [
              "PARTNER_APPROVAL_REQUIRED",
              "CERTIFICATION_REQUIRED",
            ],
            partnerApprovalRequired: true,
            liveUnavailableRegions: [],
          },
        }),
      ),
    ).toEqual([
      "Partner approval required before LIVE is possible",
      "LIVE requires a current provider certification",
    ]);

    // Older payload without liveReadiness degrades to the certification truth.
    expect(liveReadinessReasonLines(entry({}))).toEqual([
      "LIVE requires a current provider certification",
    ]);
  });

  it("absent productionLiveVerification fails closed (older cached wire payloads)", () => {
    expect(isLiveSelectable(entry({}))).toBe(false);
  });

  it("VERIFIED evidence alone is insufficient without the LIVE environment", () => {
    expect(
      isLiveSelectable(
        entry({
          environments: ["DEMO"],
          productionLiveVerification: {
            status: "VERIFIED",
            verifiedAt: null,
            evidenceRef: "docs/brokers/provider-matrix.md",
          },
        }),
      ),
    ).toBe(false);
  });

  it("UNVERIFIED evidence does not unlock LIVE either way", () => {
    expect(
      isLiveSelectable(
        entry({
          environments: ["DEMO"],
          productionLiveVerification: {
            status: "UNVERIFIED",
            verifiedAt: null,
            evidenceRef: null,
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("keyCapabilityChips", () => {
  it("surfaces only the readable key capabilities", () => {
    expect(keyCapabilityChips(entry({}))).toEqual([
      "Demo",
      "Live",
      "Market data",
      "Orders",
    ]);
    expect(
      keyCapabilityChips(entry({ capabilities: ["ACCOUNT_READ"] })),
    ).toEqual([]);
  });
});

describe("routeLabel (§AF)", () => {
  it("labels every route", () => {
    expect(routeLabel("NATIVE_API")).toBe("Direct API");
    expect(routeLabel("CTRADER")).toBe("cTrader");
    expect(routeLabel("METATRADER")).toBe("MetaTrader");
    expect(routeLabel("PAPER")).toBe("Paper");
  });
});

describe("credentialFields", () => {
  it("API_TOKEN brokers need the token", () => {
    expect(credentialFields("API_TOKEN")).toEqual({
      apiKey: true,
      apiSecret: false,
      serverUrl: false,
    });
  });

  it("OAuth brokers need nothing typed (out-of-band authorization)", () => {
    expect(credentialFields("OAUTH").apiKey).toBe(false);
  });

  it("SESSION_AUTH brokers need token + server URL", () => {
    expect(credentialFields("SESSION_AUTH").serverUrl).toBe(true);
  });
});

describe("buildConnectionRequest (fail-closed validation)", () => {
  it("builds a valid API_TOKEN request", () => {
    const result = buildConnectionRequest(
      entry({}),
      "DEMO",
      "101-004-1234567-001",
      "tok-abc",
    );
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.brokerId).toBe("oanda");
      expect(result.accountType).toBe("DEMO");
      expect(result.apiKey).toBe("tok-abc");
    }
  });

  it("rejects LIVE even when declared if production verification is absent", () => {
    const result = buildConnectionRequest(entry({}), "LIVE", "acct", "tok");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("not production-verified");
    }
  });

  it("allows LIVE only when the provider is CURRENTLY CERTIFIED (complete harness evidence)", () => {
    const result = buildConnectionRequest(
      entry({
        productionLiveVerification: {
          status: "VERIFIED",
          verifiedAt: "2026-09-01T00:00:00.000Z",
          evidenceRef: "ops/live-certification/2026-09-01",
          certifiedVia: "HARNESS_CERTIFIED",
          certificationRunRef:
            "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d@sha256:" +
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
      }),
      "LIVE",
      "acct",
      "tok",
    );
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.accountType).toBe("LIVE");
    }
  });

  it("rejects LIVE for legacy-attested providers (LEGACY_VERIFIED is not certification)", () => {
    const result = buildConnectionRequest(
      entry({
        productionLiveVerification: {
          status: "VERIFIED",
          verifiedAt: null,
          evidenceRef: "production operation — MetaApi bridge",
          certifiedVia: "LEGACY_ATTESTATION",
          certificationRunRef: null,
        },
      }),
      "LIVE",
      "acct",
      "tok",
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("not production-verified");
    }
  });

  it("rejects an unsupported environment for the entry", () => {
    const result = buildConnectionRequest(
      entry({ environments: ["DEMO"] }),
      "LIVE",
      "acct",
      "tok",
    );
    expect("error" in result).toBe(true);
  });

  it("rejects an empty account id", () => {
    const result = buildConnectionRequest(entry({}), "DEMO", "   ", "tok");
    expect("error" in result).toBe(true);
  });

  it("rejects a missing API token for API_TOKEN brokers", () => {
    const result = buildConnectionRequest(entry({}), "DEMO", "acct", "");
    expect("error" in result).toBe(true);
  });

  it("omits the apiKey from the body when blank for OAuth brokers", () => {
    const result = buildConnectionRequest(
      entry({ authenticationType: "OAUTH" }),
      "DEMO",
      "acct",
      "   ",
    );
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.apiKey).toBeUndefined();
    }
  });
});

// ── Sprint 56 correction round 5: verification-label taxonomy ────────────────

import {
  verificationLabelColor,
  verificationLabelForConnection,
  verificationLabelForEntry,
} from "../broker-screen.logic";

describe("verificationLabelForEntry (fixed six-label taxonomy)", () => {
  it("an UNVERIFIED BETA LIVE-capable provider is Production LIVE Unverified — never simply Live", () => {
    expect(
      verificationLabelForEntry(
        entry({
          productionLiveVerification: {
            status: "UNVERIFIED",
            verifiedAt: null,
            evidenceRef: null,
          },
        }),
      ),
    ).toBe("Production LIVE Unverified");
  });

  it("a CERTIFIED entry is Production LIVE Verified", () => {
    expect(
      verificationLabelForEntry(
        entry({
          status: "SUPPORTED",
          productionLiveVerification: {
            status: "VERIFIED",
            verifiedAt: "2026-09-01T00:00:00.000Z",
            evidenceRef: "ops/live-certification/2026-09-01",
            certifiedVia: "HARNESS_CERTIFIED",
            certificationRunRef:
              "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d@sha256:" +
              "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
        }),
      ),
    ).toBe("Production LIVE Verified");
  });

  it("a legacy-attested entry is Production LIVE Unverified — never a current certification (Phase 2)", () => {
    expect(
      verificationLabelForEntry(
        entry({
          status: "SUPPORTED",
          productionLiveVerification: {
            status: "VERIFIED",
            verifiedAt: null,
            evidenceRef: "production operation — MetaApi bridge",
            certifiedVia: "LEGACY_ATTESTATION",
            certificationRunRef: null,
          },
        }),
      ),
    ).toBe("Production LIVE Unverified");
  });

  it("a DEMO-only provider is DEMO only", () => {
    expect(
      verificationLabelForEntry(
        entry({ environments: ["DEMO"], capabilities: ["DEMO"] }),
      ),
    ).toBe("DEMO only");
  });

  it("an unimplemented provider is Ineligible", () => {
    expect(
      verificationLabelForEntry(
        entry({ status: "NOT_STARTED", adapterAvailable: false }),
      ),
    ).toBe("Ineligible");
  });
});

describe("verificationLabelForConnection (registry join, fail-closed)", () => {
  const connection = {
    accountType: "LIVE" as const,
    authorizationStatus: "AUTHORIZED" as const,
    providerBrokerIdentity: null,
    logicalAccountKey: null,
  };

  it("degrades fail-closed when the registry join is missing", () => {
    expect(verificationLabelForConnection(connection, null)).toBe(
      "Production LIVE Unverified",
    );
  });

  it("a DEMO-typed connection identity is DEMO only", () => {
    expect(
      verificationLabelForConnection(
        { ...connection, accountType: "DEMO" },
        null,
      ),
    ).toBe("DEMO only");
  });

  it("maps every label to a badge color (no undefined styling)", () => {
    const labels = [
      "LIVE-capable",
      "Production LIVE Verified",
      "Production LIVE Unverified",
      "Ineligible",
      "DEMO only",
      "execution disabled",
    ] as const;
    for (const label of labels) {
      expect(verificationLabelColor(label)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
