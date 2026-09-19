import * as Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),
  APP_PORT: Joi.number().default(3000),
  APP_HOST: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().default('127.0.0.1'),
    otherwise: Joi.string().default('0.0.0.0'),
  }),
  APP_NAME: Joi.string().default('iRexPro API'),
  API_PREFIX: Joi.string().default('api/v1'),
  CORS_ORIGINS: Joi.string().default('http://localhost:3001'),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_EXPIRY: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRY: Joi.string().default('7d'),

  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().default(5432),
  DB_NAME: Joi.string().required(),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_SSL: Joi.boolean().default(false),
  DB_SYNCHRONIZE: Joi.boolean().default(false),
  DB_LOGGING: Joi.boolean().default(false),
  DB_MAX_CONNECTIONS: Joi.number().default(10),

  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().optional().allow(''),
  REDIS_DB: Joi.number().default(0),
  REDIS_KEY_PREFIX: Joi.string().default('irexpro:'),

  SWAGGER_ENABLED: Joi.boolean().default(true),
  SWAGGER_PATH: Joi.string().default('api/docs'),

  THROTTLE_TTL: Joi.number().default(60),
  THROTTLE_LIMIT: Joi.number().default(100),

  COOKIE_SECRET: Joi.string().min(16).required(),

  // Independent AES-256-GCM key for TOTP seeds at rest. Production must fail
  // fast if it is absent or blank; dev/test may omit it until MFA is exercised.
  MFA_ENCRYPTION_KEY: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(32).optional().allow(''),
  }),

  // Dedicated HMAC pepper for low-entropy phone verification codes. Production
  // requires independent secret material so stored code digests are not
  // offline-enumerable after a database-only compromise.
  AUTH_VERIFICATION_PEPPER: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(32).optional().allow(''),
  }),

  // Broker credential encryption (AES-256-GCM)
  // Must be at least 32 characters (256 bits).
  // In production: managed by AWS KMS / HashiCorp Vault.
  BROKER_ENCRYPTION_KEY: Joi.string().min(32).required(),

  // MetaAPI platform token — ONE token for the entire platform (not per-user)
  // Obtain from: https://app.metaapi.cloud/api-access/generate-token
  // In production: store in AWS Secrets Manager / HashiCorp Vault
  METAAPI_TOKEN: Joi.string().optional().allow(''),

  // Round 7 (R7-impl-harness) — operator-only PRODUCTION-LIVE certification
  // master gate (IREXPRO_ALLOW_LIVE_CERTIFICATION). OPTIONAL and FAIL-CLOSED:
  // the configuration maps ONLY the EXACT string 'true' to enabled; absent,
  // blank, 'false', or anything else means DISABLED (never a default-true).
  // Any value other than 'true'/'false'/'' fails validation loudly at boot so
  // an operator typo can never silently disable (or enable) LIVE certification.
  // This gate arms the operator-run LIVE certification harness ONLY — it never
  // affects trading authorization (that remains the catalog VERIFIED process).
  IREXPRO_ALLOW_LIVE_CERTIFICATION: Joi.string().valid('true', 'false').optional().allow(''),

  // cTrader Open API platform application credentials (Sprint 56 / Task 48-B).
  // OPTIONAL — the adapter registers truthfully without them, but connections
  // fail closed with a clear configuration message. Register the platform app
  // at https://openapi.ctrader.com (Spotware approval flow). NEVER log these.
  CTRADER_CLIENT_ID: Joi.string().optional().allow(''),
  CTRADER_CLIENT_SECRET: Joi.string().optional().allow(''),
  // Comma-separated redirect URI allowlist for the cTrader OAuth flow
  // (Sprint 56 correction round). OPTIONAL — the flow fails closed (honest
  // message) when unset. NEVER log these values.
  CTRADER_REDIRECT_URIS: Joi.string().optional().allow(''),
  // Sprint 56 correction round 2 (architect finding 4) — comma-separated
  // HTTPS SERVER callback slot URI(s) registered on the cTrader Open API
  // application for MOBILE flows. OPTIONAL — mobile-channel authorizations
  // fail closed (honest operator guidance) when unset. NEVER log these.
  CTRADER_MOBILE_CALLBACK_URIS: Joi.string().optional().allow(''),
  // Controlled deep link the server callback redirects to with the one-time
  // handoff token. OPTIONAL — defaults to irexpro://broker/oauth/handoff.
  CTRADER_MOBILE_DEEP_LINK: Joi.string().optional().allow(''),

  // Internal API key for Python AI Engine → NestJS communication.
  // Must match NESTJS_INTERNAL_API_KEY in services/ai-engine/.env.
  // In production: store in AWS Secrets Manager / HashiCorp Vault.
  NESTJS_INTERNAL_API_KEY: Joi.string().optional().allow(''),

  // Python AI engine scheduler coordination (NestJS → AI engine)
  AI_ENGINE_BASE_URL: Joi.string().default('http://localhost:8001/api/v1'),
  AI_ENGINE_SCHEDULER_ENABLED: Joi.boolean().default(false),
  AI_ENGINE_INSTRUMENTS: Joi.string().default('EURUSD,GBPUSD,USDJPY,AUDUSD,USDCHF,USDCAD'),
  AI_ENGINE_TIMEFRAMES: Joi.string().default('M15,H1,H4'),
  AI_ENGINE_SIGNAL_INTERVAL_SECONDS: Joi.number().integer().min(15).max(3600).default(60),

  // Paystack sandbox integration (Sprint 15) — fail-closed by default.
  // PAYSTACK_SECRET_KEY must never be logged or returned; only present in local .env.
  PAYSTACK_ENABLED: Joi.boolean().default(false),
  PAYSTACK_SECRET_KEY: Joi.string().optional().allow(''),
  PAYSTACK_PUBLIC_KEY: Joi.string().optional().allow(''),
  PAYSTACK_WEBHOOK_SECRET: Joi.string().optional().allow(''),
  PAYSTACK_BASE_URL: Joi.string().default('https://api.paystack.co'),
  PAYSTACK_CALLBACK_URL: Joi.string().optional().allow(''),

  // Stripe sandbox integration (Sprint 17) — fail-closed by default.
  // STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET must never be logged or returned;
  // only present in local .env. The app must boot without either being set.
  STRIPE_ENABLED: Joi.boolean().default(false),
  STRIPE_SECRET_KEY: Joi.string().optional().allow(''),
  STRIPE_PUBLISHABLE_KEY: Joi.string().optional().allow(''),
  STRIPE_WEBHOOK_SECRET: Joi.string().optional().allow(''),
  STRIPE_BASE_URL: Joi.string().default('https://api.stripe.com'),
  STRIPE_SUCCESS_URL: Joi.string().optional().allow(''),
  STRIPE_CANCEL_URL: Joi.string().optional().allow(''),

  // Sprint 28 — password reset / verification delivery.
  WEB_BASE_URL: Joi.string().optional().allow(''),
  ADMIN_BASE_URL: Joi.string().optional().allow(''),
  EMAIL_SMTP_URL: Joi.string().optional().allow(''),
  EMAIL_FROM: Joi.string().optional().allow(''),
  EMAIL_FROM_ADDRESS: Joi.string().optional().allow(''),

  // Sprint 48 — phone verification delivery. Provider values stay optional so
  // the service can fail closed when SMS is intentionally not configured.
  TWILIO_ACCOUNT_SID: Joi.string().optional().allow(''),
  TWILIO_AUTH_TOKEN: Joi.string().optional().allow(''),
  TWILIO_API_KEY: Joi.string().optional().allow(''),
  TWILIO_API_SECRET: Joi.string().optional().allow(''),
  TWILIO_FROM_NUMBER: Joi.string().optional().allow(''),
});
