/**
 * Shared api-client broker-registry contract tests (architect Phase I1).
 *
 * GET /broker/registry returns the CATALOG WRAPPER
 * `{ catalogVersion, brokers: BrokerRegistryEntry[] }` (registry Phase H
 * materializes productionLiveVerification on every entry). The api-client
 * method was previously typed as a bare entry array, so the mobile screen
 * crashed mapping the wrapper — these tests lock BOTH the compile-time
 * typed contract (checked by `tsc --noEmit`) and the runtime JSON
 * passthrough.
 */
import type { ApiClient } from "@irexpro/api-client";
import { createApiClient } from "@irexpro/api-client";
import type { BrokerRegistryCatalog } from "@irexpro/types";

// ── Compile-time contract ─────────────────────────────────────────────────
// getBrokerRegistry must resolve the catalog WRAPPER, never a bare
// BrokerRegistryEntry[] (tsc fails on the assignment below if the
// api-client type regresses to the array shape).
type RegistryResult = Awaited<ReturnType<ApiClient["getBrokerRegistry"]>>;
const catalogShape: RegistryResult = { catalogVersion: "v-2025-09", brokers: [] };

const catalog: BrokerRegistryCatalog = {
  catalogVersion: "v-2025-09",
  brokers: [
    {
      id: "metatrader5",
      name: "MetaTrader 5",
      description: "MetaApi bridge",
      status: "SUPPORTED",
      productionLiveVerification: {
        status: "VERIFIED",
        verifiedAt: null,
        evidenceRef: "production operation — MetaApi bridge",
      },
      connectionRoutes: ["METATRADER"],
      capabilities: ["LIVE", "DEMO"],
      authenticationType: "SESSION_AUTH",
      environments: ["DEMO", "LIVE"],
      regions: [],
      adapterAvailable: true,
    },
    {
      id: "beta-broker",
      name: "Beta Broker",
      description: "",
      status: "BETA",
      productionLiveVerification: {
        status: "UNVERIFIED",
        verifiedAt: null,
        evidenceRef: null,
      },
      connectionRoutes: ["NATIVE_API"],
      capabilities: ["DEMO"],
      authenticationType: "API_TOKEN",
      environments: ["DEMO"],
      regions: [],
      adapterAvailable: true,
    },
  ],
};

describe("createApiClient().getBrokerRegistry (Phase I1 shape fix)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("resolves the server catalog wrapper { catalogVersion, brokers }", async () => {
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        (async () =>
          ({
            ok: true,
            status: 200,
            json: async () => catalog,
          }) as unknown as Response) as typeof fetch,
      );
    const client = createApiClient({
      baseUrl: "https://api.example.com/api/v1",
    });

    const result = await client.getBrokerRegistry();

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.example.com/api/v1/broker/registry",
      expect.objectContaining({ headers: expect.anything() }),
    );
    // The response is the WRAPPER — the entry array lives under `.brokers`
    // (the old contract typed the wrapper as an array; consumers that
    // mapped it directly crashed at runtime).
    expect(Array.isArray(result)).toBe(false);
    expect(result).toEqual(catalog);
    expect(result.catalogVersion).toBe("v-2025-09");
    expect(result.brokers).toHaveLength(2);
    expect(result.brokers[0].productionLiveVerification?.status).toBe(
      "VERIFIED",
    );
    expect(result.brokers[1].productionLiveVerification?.status).toBe(
      "UNVERIFIED",
    );
  });

  it("the typed contract is the catalog wrapper (compile-time assertion)", () => {
    expect(catalogShape.catalogVersion).toBe("v-2025-09");
    expect(catalogShape.brokers).toEqual([]);
  });
});
