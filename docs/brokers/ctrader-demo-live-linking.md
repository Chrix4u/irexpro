# cTrader DEMO and LIVE account linking — execution separated from connection

## Owner decision, 2026-11-22

An iRexPro user may link separate DEMO and LIVE cTrader broker accounts
under the same identity. Each account is explicitly selected from the
provider-returned OAuth account list, and credentials are encrypted. A
second account requires a separate OAuth authorization/link flow.
The same connection records appear in web and native clients.

LIVE account linking is NOT real-money order authorization. Existing
provider-specific production-LIVE certification, validated DEMO results,
broker identity, user approval and all execution/risk controls are
unchanged. Newly saved connections are DISCONNECTED and NOT_CONNECTED
with liveTradingEnabled false. No broker orders are placed by linking.

## Server and client boundaries

- cTrader family only: ctrader, pepperstone-ctrader, icmarkets-ctrader.
- Environment is derived from provider account discovery isLive, never
  a browser/mobile assertion. Alias broker identity matching remains.
- The internal oauthDiscoveredLiveLinkOnly permission is passed only
  from server OAuth account linking. It requires a server flow ID and
  server-derived logical account key. Public broker DTOs cannot set it.
  Manual unverified LIVE connections and OANDA tokens remain blocked.
- Separate user accounts, credential encryption, immutable logical
  account keys and OAuth replay protection remain in effect.
- A successful provider connection/credential validation never implies
  live trading authorization. enableLiveTrading still rejects BETA or
  operator-unverified LIVE brokers.
- No Windows VPS or MetaAPI plan is introduced.

## Pepperstone $50 LIVE trial

- The Pepperstone account MUST be a cTrader account; MT5-only accounts
  cannot use cTrader Open API OAuth.
- Confirm provider app approval and exact registered OAuth redirect URIs.
  During 2026-11-22 inspection, platform credentials and the web OAuth
  callback were configured, while the native mobile callback setting
  CTRADER_MOBILE_CALLBACK_URIS was missing. Therefore Android/iOS in-app
  authorization is blocked until its callback is registered. Mobile
  phone browsers can use the existing web authorization route.
- Link one DEMO account and one LIVE account through separate OAuth
  authorizations. Assert unique broker IDs, accurate demo/live labels,
  isolated balances and no cross-account order/account mixing.
- Assert LIVE linking and connection leave liveTradingEnabled false
  and attempting LIVE authorization still rejects without an order.
- Before any eventual real-money automation: genuine account-specific
  broker certification, completed DEMO validation, documented low
  exposure bounds, stop-loss, spread, commission and margin validation,
  exact user consent and an authorized minimal LIVE canary are required.
- The earlier 3/4 lot DEMO preferences must not be copied to a $50
  real-money account. Profit is not guaranteed, losses may exhaust
  the deposit.
