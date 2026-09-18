# 22 — SMS Provider Architecture

## iRexPro — Global SMS and Notification Provider Interface

---

## 1. Purpose

This document defines the SMS provider architecture for iRexPro — a provider-agnostic, globally extensible messaging layer. The system must never be hard-coded to a single SMS provider. Provider selection is driven by user country and regional availability.

---

## 2. Core Design Principle

iRexPro uses a **pluggable SMS provider architecture**. SMS providers are interchangeable implementations of a common interface. Country configuration determines which provider handles messages for a given user. Adding a new provider requires only a new adapter implementation.

```
SMS Send Request (event-driven)
  → SmsProviderRouter
    → Selects provider based on: user.country + provider.supportedCountries
    → Calls ISmsProvider implementation
      → [Twilio | Hubtel | Arkesel | AWS SNS | ...]
    → Returns SmsDeliveryResult
  → NotificationModule records delivery status
  → AuditModule logs message event (type only, not content)
```

---

## 3. ISmsProvider Interface

```typescript
interface ISmsProvider {
  readonly providerId: string;          // e.g., "twilio", "hubtel", "arkesel"
  readonly providerName: string;        // e.g., "Twilio", "Hubtel", "Arkesel"
  readonly supportedCountries: string[]; // ISO 3166-1 alpha-2 codes; '*' = global
  readonly supportsDeliveryReceipts: boolean;
  readonly supportsSenderId: boolean;   // Custom sender name support

  sendSms(params: SmsSendParams): Promise<SmsDeliveryResult>;
  getDeliveryStatus(messageId: string): Promise<SmsDeliveryStatus>;
}
```

---

## 4. Core Data Types

```typescript
interface SmsSendParams {
  to: string;           // E.164 format: +233201234567
  body: string;         // Message text (max 160 chars per segment)
  senderId?: string;    // Sender name or number (if provider supports it)
  messageType: SmsMessageType;
  metadata?: Record<string, string>;  // userId, eventType for internal tracking
}

interface SmsDeliveryResult {
  success: boolean;
  messageId?: string;       // Provider-assigned message ID
  providerId: string;
  status: SmsDeliveryStatus;
  segmentCount: number;     // Number of SMS segments (for billing/tracking)
  error?: string;
}

enum SmsDeliveryStatus {
  QUEUED = 'QUEUED',
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  UNDELIVERED = 'UNDELIVERED',
  UNKNOWN = 'UNKNOWN',
}

enum SmsMessageType {
  OTP = 'OTP',
  SECURITY_ALERT = 'SECURITY_ALERT',
  SUBSCRIPTION_ALERT = 'SUBSCRIPTION_ALERT',
  PAYMENT_ALERT = 'PAYMENT_ALERT',
  TRADING_SESSION_ALERT = 'TRADING_SESSION_ALERT',
  TRADE_EVENT_ALERT = 'TRADE_EVENT_ALERT',
  RISK_ALERT = 'RISK_ALERT',
  BROKER_CONNECTION_ALERT = 'BROKER_CONNECTION_ALERT',
  GENERAL = 'GENERAL',
}
```

---

## 5. SMS Provider Registry and Router

```typescript
class SmsProviderRegistry {
  private providers: Map<string, ISmsProvider> = new Map();

  register(provider: ISmsProvider): void {
    this.providers.set(provider.providerId, provider);
  }

  getProvider(providerId: string): ISmsProvider {
    const p = this.providers.get(providerId);
    if (!p) throw new Error(`SMS provider '${providerId}' not registered`);
    return p;
  }
}

class SmsProviderRouter {
  selectProvider(userCountry: string, messageType: SmsMessageType): ISmsProvider {
    // 1. Check country config for preferred SMS provider
    const countryConfig = this.countryConfigService.getConfig(userCountry);
    if (countryConfig?.preferredSmsProvider) {
      const preferred = this.registry.getProvider(countryConfig.preferredSmsProvider);
      if (preferred.supportedCountries.includes(userCountry) ||
          preferred.supportedCountries.includes('*')) {
        return preferred;
      }
    }

    // 2. For OTP: prefer providers with lowest latency in that country
    if (messageType === SmsMessageType.OTP) {
      const otpProviders = this.getProvidersForCountry(userCountry)
        .filter(p => p.supportsDeliveryReceipts);  // Prefer reliable OTP providers
      if (otpProviders.length > 0) return otpProviders[0];
    }

    // 3. Fall back to global provider
    const global = this.registry.getProvider('twilio');
    if (global) return global;

    throw new SmsProviderUnavailableException(userCountry);
  }
}
```

---

## 6. Supported SMS Providers

> **Implementation status — 2026-09-18.** Twilio is production-capable when
> its validated account/sender credentials are configured. Hubtel and Arkesel
> remain registered placeholders and are deliberately excluded from runtime
> selection until their adapters are implemented and configured. The registry
> fails closed when no live provider can serve the target country; it never
> routes a message to a placeholder merely because that provider is registered.


### 6.1 Global Providers

| Provider | ID | Countries | Strengths |
|---|---|---|---|
| **Twilio** | `twilio` | Global (`*`) | Excellent reliability, delivery receipts, global coverage, OTP best-in-class |
| **AWS SNS** | `aws_sns` | Global (`*`) | Cost-effective at scale, tight AWS integration |
| **MessageBird** | `messagebird` (future) | Global | Competitive pricing, good Africa coverage |
| **Vonage (Nexmo)** | `vonage` (future) | Global | Long-standing provider, good APIs |

### 6.2 Africa / Ghana Regional Providers

| Provider | ID | Countries | Strengths |
|---|---|---|---|
| **Hubtel** | `hubtel` | GH | Ghana-first; local delivery, mobile money integration, custom sender IDs |
| **Arkesel** | `arkesel` | GH, NG, KE, ZA, GH | Africa-focused; competitive pricing, bulk SMS, OTP support |
| **Africa's Talking** | `africastalking` (future) | 18 African countries | Developer-friendly, local routing |
| **mNotify** | `mnotify` (future) | GH | Ghana-specific, bulk SMS |

### 6.3 Provider Selection by Country (Default Configuration)

| Country | Primary SMS Provider | Fallback |
|---|---|---|
| Ghana (GH) | `hubtel` | `arkesel` → `twilio` |
| Nigeria (NG) | `arkesel` | `twilio` |
| Kenya (KE) | `arkesel` | `twilio` |
| South Africa (ZA) | `twilio` | `arkesel` |
| United Kingdom (GB) | `twilio` | `aws_sns` |
| United States (US) | `twilio` | `aws_sns` |
| All other countries | `twilio` | `aws_sns` |

Provider selection is configurable in `CountryConfig` — not hardcoded.

---

## 7. Message Templates

All SMS messages use a template system to ensure consistency, brevity, and no accidental PII exposure.

### 7.1 OTP Message

```
iRexPro: Your verification code is {code}. Valid for {expiryMinutes} minutes. 
Do not share this code.
```

### 7.2 Login Security Alert

```
iRexPro: New login detected from {device} at {time} ({timezone}). 
Not you? Secure your account immediately at irexpro.com/security
```

### 7.3 Subscription Activated

```
iRexPro: Your {planName} subscription is now active. 
AI Auto Trading is available. Log in to activate.
```

### 7.4 Subscription Payment Failed

```
iRexPro: Payment failed for your {planName} subscription. 
Update your payment method within {graceDays} days to avoid suspension. 
irexpro.com/billing
```

### 7.5 AI Auto Trading Activated

```
iRexPro: AI Auto Trading is now ACTIVE on your {brokerName} account. 
To stop: irexpro.com/dashboard or reply STOP.
```

### 7.6 AI Auto Trading Stopped

```
iRexPro: AI Trading has been STOPPED.
iRexPro requested closure of positions opened by the AI.
Log in to review any unverified or unresolved closures: irexpro.com/dashboard
```

The server-authoritative stop result determines whether closure is COMPLETE,
PARTIAL, or UNKNOWN. Notification copy must never claim a position is closed
unless provider-backed state confirms it.

### 7.7 Trade Opened Alert

```
iRexPro: Trade opened - {direction} {instrument} {lotSize} lots @ {price}. 
SL: {sl} | TP: {tp}
```

### 7.8 Trade Closed Alert

```
iRexPro: Trade closed - {instrument} {direction}. 
P&L: {pnl} {currency}. 
Running total: irexpro.com/performance
```

### 7.9 Risk Limit Reached

```
iRexPro RISK ALERT: {riskRule} limit reached. 
AI Trading suspended for your safety. 
Log in for details: irexpro.com/dashboard
```

### 7.10 Broker Connection Lost

```
iRexPro: Broker connection lost ({brokerName}). 
AI Trading paused. Reconnect at: irexpro.com/broker
```

---

## 8. OTP Security Requirements

OTPs sent via SMS must comply with:

- **Length:** 6 digits
- **Expiry:** 10 minutes (configurable)
- **Rate limiting:** Max 3 OTP requests per phone number per 30 minutes
- **Attempt limiting:** OTP invalidated after 5 failed verification attempts
- **One-time use:** OTP is invalidated immediately on first successful use
- **No logging of OTP values:** Only the fact of dispatch is logged, never the code itself
- **Resend cooldown:** 60-second cooldown between OTP resend requests

```sql
CREATE TABLE identity.otp_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES identity.users(id),
  phone_number    VARCHAR(20) NOT NULL,
  purpose         VARCHAR(30) NOT NULL,  -- 'PHONE_VERIFY', 'LOGIN_MFA', 'PASSWORD_RESET'
  code_hash       VARCHAR(255) NOT NULL, -- bcrypt hash of code — never store plaintext
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_otp_user_purpose ON identity.otp_records(user_id, purpose, created_at);
```

---

## 9. SMS Delivery Tracking

```sql
CREATE TABLE notifications.sms_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES identity.users(id),
  provider_id     VARCHAR(30) NOT NULL,
  message_type    VARCHAR(40) NOT NULL,
  phone_number    VARCHAR(20) NOT NULL,
  provider_msg_id VARCHAR(255),
  status          VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  segment_count   INTEGER NOT NULL DEFAULT 1,
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  failed_at       TIMESTAMPTZ,
  failure_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- Message body is NOT stored here — PII minimisation
);

CREATE INDEX idx_sms_deliveries_user_id ON notifications.sms_deliveries(user_id);
CREATE INDEX idx_sms_deliveries_created_at ON notifications.sms_deliveries(created_at);
```

---

## 10. Notification Channel Priority

For critical alerts, iRexPro uses multiple channels with fallback:

| Message Type | Primary | Secondary | Tertiary |
|---|---|---|---|
| OTP | SMS | Email | — |
| Security alert | SMS | Email | Push |
| Trade opened | Push | Email | SMS (if configured) |
| Trade closed | Push | Email | SMS (if configured) |
| Risk limit reached | Push + SMS | Email | — |
| Broker disconnected | Push + SMS | Email | — |
| Subscription payment failed | Email | SMS | Push |
| Subscription activated | Email | Push | SMS |
| AI trading activated | Push | SMS | — |
| AI trading stopped | Push | SMS | — |

Users can configure their notification preferences (which channels to enable for each message type) in account settings.

---

## 11. Rate Limiting and Cost Control

SMS has direct per-message costs. Controls to prevent abuse:

| Control | Rule |
|---|---|
| OTP rate limit | Max 3 sends per phone number per 30 minutes |
| Trade alert throttle | Max 10 trade SMS alerts per user per day (configurable) |
| Alert deduplication | Identical alert within 5 minutes for same user: suppress duplicate |
| Admin override | SuperAdmin can enable unlimited SMS for specific users (e.g., VIP) |
| Cost monitoring | CloudWatch/Prometheus alert if SMS spend exceeds daily threshold |

---

## 12. Failure Handling

| Failure | Response |
|---|---|
| Provider API timeout | Retry once after 5s; if still failing, fall back to next provider |
| Invalid phone number | Log delivery failure; do not retry; notify user via email instead |
| Provider service outage | Switch to fallback provider immediately |
| Delivery failure (UNDELIVERED) | Log; switch to fallback provider for next attempt |
| OTP delivery failure | Offer user "resend via email" as alternative |
| Rate limit hit at provider | Back off and queue for next available slot |
