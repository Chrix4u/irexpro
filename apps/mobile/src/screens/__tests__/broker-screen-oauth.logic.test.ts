/**
 * BrokerScreen OAuth flow logic tests (Sprint 56 correction round 2 /
 * architect finding 4) — pure functions, no React Native required.
 *
 * The deep link the server handoff redirect produces carries ONLY the
 * opaque one-time handoff token (never a provider authorization code).
 */
import type { BrokerOAuthAccount } from "@irexpro/types";
import {
  BROKER_APP_SCHEME,
  BROKER_OAUTH_AWAIT_TIMEOUT_MS,
  BROKER_OAUTH_HANDOFF_PATH,
  brokerOAuthHandoffLinkBase,
  buildOAuthLinkRequest,
  oauthAccountOptions,
  oauthDisplayName,
  parseBrokerOAuthHandoffLink,
} from "../broker-screen-oauth.logic";

const account = (overrides: Partial<BrokerOAuthAccount> = {}): BrokerOAuthAccount => ({
  ctidTraderAccountId: "1234567",
  isLive: false,
  ...overrides,
});

describe("brokerOAuthHandoffLinkBase + wait watchdog constants", () => {
  it("builds the handoff deep-link base from the registered scheme", () => {
    expect(brokerOAuthHandoffLinkBase()).toBe("irexpro://broker/oauth/handoff");
    expect(BROKER_APP_SCHEME).toBe("irexpro");
    expect(BROKER_OAUTH_HANDOFF_PATH).toBe("broker/oauth/handoff");
  });

  it("waits ~10 minutes before timing out the browser return", () => {
    expect(BROKER_OAUTH_AWAIT_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });
});

describe("parseBrokerOAuthHandoffLink", () => {
  it("extracts the one-time handoff token from the exact route", () => {
    expect(
      parseBrokerOAuthHandoffLink("irexpro://broker/oauth/handoff?token=abc123"),
    ).toEqual({ token: "abc123" });
  });

  it("returns the opaque error reason on the failure/cancel route", () => {
    expect(
      parseBrokerOAuthHandoffLink("irexpro://broker/oauth/handoff?error=provider-error"),
    ).toEqual({ error: "provider-error" });
  });

  it("ignores unrelated deep links (never treats them as OAuth completions)", () => {
    expect(parseBrokerOAuthHandoffLink("irexpro://dashboard")).toBeNull();
    expect(parseBrokerOAuthHandoffLink("irexpro://broker/oauth/other?token=abc")).toBeNull();
    // The legacy code-callback route is GONE — it must never complete a flow.
    expect(
      parseBrokerOAuthHandoffLink("irexpro://broker/oauth/callback?code=abc"),
    ).toBeNull();
    expect(parseBrokerOAuthHandoffLink("")).toBeNull();
  });

  it("rejects a non-app scheme", () => {
    expect(
      parseBrokerOAuthHandoffLink(
        "https://app.example.com/broker/oauth/handoff?token=abc",
      ),
    ).toBeNull();
    expect(
      parseBrokerOAuthHandoffLink("otherapp://broker/oauth/handoff?token=abc"),
    ).toBeNull();
  });

  it("rejects the route without a usable token or error reason", () => {
    expect(parseBrokerOAuthHandoffLink("irexpro://broker/oauth/handoff")).toBeNull();
    expect(parseBrokerOAuthHandoffLink("irexpro://broker/oauth/handoff?token=")).toBeNull();
    expect(parseBrokerOAuthHandoffLink("irexpro://broker/oauth/handoff?error=")).toBeNull();
    expect(parseBrokerOAuthHandoffLink("irexpro://broker/oauth/handoff?other=1")).toBeNull();
  });

  it("tolerates path-leading slashes and ignores extra unrelated params", () => {
    expect(
      parseBrokerOAuthHandoffLink(
        "irexpro://broker/oauth/handoff/?token=x&unrelated=1",
      ),
    ).toEqual({ token: "x" });
    expect(
      parseBrokerOAuthHandoffLink(
        "irexpro://broker/oauth/handoff/?error=provider-error&unrelated=1",
      ),
    ).toEqual({ error: "provider-error" });
  });

  it("prefers the token when both params are present (server sends one)", () => {
    expect(
      parseBrokerOAuthHandoffLink("irexpro://broker/oauth/handoff?token=t&error=e"),
    ).toEqual({ token: "t" });
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
