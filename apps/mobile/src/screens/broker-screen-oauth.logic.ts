/**
 * BrokerScreen OAuth flow logic (Sprint 56 correction round 2 / architect
 * finding 4) — pure, React-Native-free so it is unit-testable per
 * Directive §J.
 *
 * The mobile cTrader OAuth flow is a SERVER-callback handoff — the app
 * custom scheme is NEVER the production OAuth callback:
 *   1. `startBrokerOAuth(brokerId, { channel: "mobile" })` → the response
 *      carries the official id.ctrader.com consent URL. The URL embeds a
 *      SERVER-assigned HTTPS callback slot; the app just opens it in the
 *      EXTERNAL system browser (the app never sees the cTrader password).
 *   2. The user consents in the browser. Spotware redirects to the
 *      registered HTTPS SERVER callback; the SERVER immediately exchanges
 *      the authorization code with the platform app credentials and issues
 *      an opaque, one-time, user-bound, short-TTL handoff token.
 *   3. The server responds with an HTTP redirect to the app deep link:
 *      `irexpro://broker/oauth/handoff?token=<handoffToken>` (or
 *      `?error=<reason>` on failure/cancel).
 *   4. The app parses the deep link (parseBrokerOAuthHandoffLink) and
 *      exchanges the handoff token via exchangeBrokerOAuthHandoff →
 *      sanitized discovered accounts (NO token material).
 *   5. The user picks an account → linkBrokerOAuth → encrypted
 *      BrokerConnection.
 *
 * SECRECY BOUNDARY (architect finding 4): the provider authorization code,
 * access token, refresh token, and client secret NEVER reach the mobile
 * app. The deep link carries ONLY the opaque one-time handoff token —
 * useless to interceptors (user-bound, single-use, ~2-minute TTL).
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

/** Deep-link route the SERVER handoff redirect must match exactly. */
export const BROKER_OAUTH_HANDOFF_PATH = "broker/oauth/handoff";

/**
 * How long the app waits for the browser round trip before clearing the
 * awaiting state with honest feedback (no API call — the server-side flow
 * TTL governs the real expiry; this is purely a UI watchdog).
 */
export const BROKER_OAUTH_AWAIT_TIMEOUT_MS = 10 * 60 * 1000;

/** The handoff deep-link base (tests + documentation of the boundary). */
export function brokerOAuthHandoffLinkBase(): string {
  return `${BROKER_APP_SCHEME}://${BROKER_OAUTH_HANDOFF_PATH}`;
}

/**
 * Parses an incoming deep link into the OAuth handoff outcome.
 *
 * Exact route match `irexpro://broker/oauth/handoff` only:
 *   - non-empty `token` param → { token } (one-time handoff token);
 *   - else non-empty `error` param → { error } (opaque failure reason);
 *   - anything else → null — unrelated deep links (including the legacy
 *     code-callback route) are NEVER treated as OAuth completions.
 */
export function parseBrokerOAuthHandoffLink(
  url: string,
): { token: string } | { error: string } | null {
  if (typeof url !== "string" || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${BROKER_APP_SCHEME}:`) return null;
  // Host/path forms: "irexpro://broker/oauth/handoff" (host "broker", path
  // "/oauth/handoff") — compare the full trimmed route.
  const route = `${parsed.host}${parsed.pathname}`
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (route !== BROKER_OAUTH_HANDOFF_PATH) return null;
  const token = parsed.searchParams.get("token");
  if (token && token.trim() !== "") return { token: token.trim() };
  const error = parsed.searchParams.get("error");
  if (error && error.trim() !== "") return { error: error.trim() };
  return null;
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
