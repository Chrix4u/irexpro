/**
 * BrokerScreen OAuth flow logic (Sprint 56 correction round 1 / audit
 * point 6) — pure, React-Native-free so it is unit-testable per
 * Directive §J.
 *
 * The mobile cTrader OAuth flow:
 *   1. `startBrokerOAuth(brokerId, mobileRedirectUri)` — the redirect URI is
 *      the app's registered deep link (scheme "irexpro"); the SERVER
 *      allowlist (CTRADER_REDIRECT_URIS) must include it or the start fails
 *      closed with an honest message (the operator must register the deep
 *      link on the platform cTrader Open API application).
 *   2. The consent screen opens in the system browser (external — the app
 *      never sees the cTrader password). Spotware redirects to the deep
 *      link carrying the single-use authorization code.
 *   3. The app parses the deep link (parseBrokerOAuthDeepLink), exchanges
 *      the code (completeBrokerOAuth — server-side, platform app
 *      credentials), and shows the discovered accounts.
 *   4. The user picks an account → linkBrokerOAuth → encrypted BrokerConnection.
 *
 * Honesty rules mirror the server: DEMO accounts are linkable; LIVE
 * accounts stay blocked until operator-attested production-LIVE
 * verification exists (the server fails closed regardless).
 */
import type {
  BrokerOAuthAccount,
  LinkBrokerOAuthRequest,
} from "@irexpro/types";

/** The app's registered deep-link scheme (app.json "scheme"). */
export const BROKER_APP_SCHEME = "irexpro";

/** Deep-link path the OAuth redirect must match exactly. */
export const BROKER_OAUTH_DEEP_LINK_PATH = "broker/oauth/callback";

/** The full mobile OAuth redirect URI (must be server-allowlisted). */
export function mobileOAuthRedirectUri(): string {
  return `${BROKER_APP_SCHEME}://${BROKER_OAUTH_DEEP_LINK_PATH}`;
}

/**
 * Parses an incoming deep link into the OAuth authorization code.
 * Returns null for any URL that is not the exact OAuth callback route —
 * unrelated deep links must never be treated as OAuth completions.
 */
export function parseBrokerOAuthDeepLink(url: string): { code: string } | null {
  if (typeof url !== "string" || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${BROKER_APP_SCHEME}:`) return null;
  // Host/path forms: "irexpro://broker/oauth/callback" (host "broker", path
  // "/oauth/callback") — compare the full trimmed route.
  const route = `${parsed.host}${parsed.pathname}`
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (route !== BROKER_OAUTH_DEEP_LINK_PATH) return null;
  const code = parsed.searchParams.get("code");
  if (!code || code.trim() === "") return null;
  return { code: code.trim() };
}

/** Presentation state for a discovered account (honest LIVE gating). */
export interface OAuthAccountOption {
  account: BrokerOAuthAccount;
  selectable: boolean;
  /** Honest reason shown for non-selectable accounts. */
  note?: string;
}

/**
 * Maps discovered accounts to selectable options. DEMO accounts are
 * selectable; LIVE accounts are NOT (production-LIVE verification is
 * pending for cTrader-family brokers — platform compatibility is
 * contract-tested, LIVE verification is an operator evidence program).
 */
export function oauthAccountOptions(accounts: BrokerOAuthAccount[]): OAuthAccountOption[] {
  return accounts.map((account) =>
    account.isLive
      ? {
          account,
          selectable: false,
          note:
          "LIVE linking is pending — it requires operator-attested production-LIVE verification evidence. Connect the matching DEMO account for now.",
        }
      : { account, selectable: true },
  );
}

/** Default display name for a linked OAuth connection. */
export function oauthDisplayName(account: BrokerOAuthAccount): string {
  return `${account.brokerTitleShort ?? "cTrader"} DEMO ${account.ctidTraderAccountId}`;
}

/** Builds the link request for a chosen account (pure). */
export function buildOAuthLinkRequest(
  flowId: string,
  account: BrokerOAuthAccount,
  displayName?: string,
): LinkBrokerOAuthRequest {
  return {
    flowId,
    ctidTraderAccountId: account.ctidTraderAccountId,
    displayName: displayName ?? oauthDisplayName(account),
  };
}
