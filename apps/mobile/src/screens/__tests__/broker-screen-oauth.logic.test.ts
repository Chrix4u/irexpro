/**
 * BrokerScreen OAuth flow logic tests (Sprint 56 correction round 1 /
 * audit point 6) — pure functions, no React Native required.
 */
import type { BrokerOAuthAccount } from "@irexpro/types";
import {
  BROKER_APP_SCHEME,
  BROKER_OAUTH_DEEP_LINK_PATH,
  buildOAuthLinkRequest,
  mobileOAuthRedirectUri,
  oauthAccountOptions,
  oauthDisplayName,
  parseBrokerOAuthDeepLink,
} from "../broker-screen-oauth.logic";

const account = (overrides: Partial<BrokerOAuthAccount> = {}): BrokerOAuthAccount => ({
  ctidTraderAccountId: "1234567",
  isLive: false,
  ...overrides,
});

describe("mobileOAuthRedirectUri", () => {
  it("builds the app deep link from the registered scheme", () => {
    expect(mobileOAuthRedirectUri()).toBe("irexpro://broker/oauth/callback");
    expect(BROKER_APP_SCHEME).toBe("irexpro");
    expect(BROKER_OAUTH_DEEP_LINK_PATH).toBe("broker/oauth/callback");
  });
});

describe("parseBrokerOAuthDeepLink", () => {
  it("extracts the code from the exact OAuth callback route", () => {
    expect(
      parseBrokerOAuthDeepLink("irexpro://broker/oauth/callback?code=abc123"),
    ).toEqual({ code: "abc123" });
  });

  it("ignores unrelated deep links (never treats them as OAuth completions)", () => {
    expect(parseBrokerOAuthDeepLink("irexpro://dashboard")).toBeNull();
    expect(parseBrokerOAuthDeepLink("irexpro://broker/oauth/other?code=abc")).toBeNull();
    expect(parseBrokerOAuthDeepLink("https://app.example.com/callback?code=abc")).toBeNull();
    expect(parseBrokerOAuthDeepLink("")).toBeNull();
  });

  it("rejects a callback without a usable code", () => {
    expect(parseBrokerOAuthDeepLink("irexpro://broker/oauth/callback")).toBeNull();
    expect(parseBrokerOAuthDeepLink("irexpro://broker/oauth/callback?code=")).toBeNull();
    expect(parseBrokerOAuthDeepLink("irexpro://broker/oauth/callback?other=1")).toBeNull();
  });

  it("tolerates path-leading slashes and extra params", () => {
    expect(
      parseBrokerOAuthDeepLink("irexpro://broker/oauth/callback/?code=x&state=y"),
    ).toEqual({ code: "x" });
  });
});

describe("oauthAccountOptions (honest LIVE gating)", () => {
  it("marks DEMO accounts selectable and LIVE accounts blocked with the honest reason", () => {
    const options = oauthAccountOptions([
      account(),
      account({ ctidTraderAccountId: "7654321", isLive: true }),
    ]);
    expect(options[0].selectable).toBe(true);
    expect(options[0].note).toBeUndefined();
    expect(options[1].selectable).toBe(false);
    expect(options[1].note).toContain("production-LIVE");
  });

  it("never renders a LIVE account as simply verified (§AB honesty)", () => {
    const options = oauthAccountOptions([account({ isLive: true })]);
    expect(options[0].selectable).toBe(false);
    // The note states LIVE linking is PENDING evidence — it never claims the
    // broker is verified.
    expect(options[0].note).toContain("pending");
    expect(options[0].note).not.toContain("is verified");
    expect(options[0].note).not.toContain("LIVE verified");
  });
});

describe("buildOAuthLinkRequest", () => {
  it("builds the link request with the default display name", () => {
    const request = buildOAuthLinkRequest("flow-1", account());
    expect(request).toEqual({
      flowId: "flow-1",
      ctidTraderAccountId: "1234567",
      displayName: "cTrader DEMO 1234567",
    });
  });

  it("uses the broker title and the caller-supplied display name", () => {
    expect(
      oauthDisplayName(account({ brokerTitleShort: "Pepperstone", ctidTraderAccountId: "99" })),
    ).toBe("Pepperstone DEMO 99");
    const request = buildOAuthLinkRequest("flow-2", account(), "Custom label");
    expect(request.displayName).toBe("Custom label");
  });
});
