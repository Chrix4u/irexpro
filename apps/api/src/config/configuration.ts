import { parseCorsOrigins } from './cors-origins';

export default () => ({
  app: {
    port: parseInt(process.env.APP_PORT ?? '3000', 10),
    host:
      process.env.APP_HOST ??
      ((process.env.NODE_ENV ?? 'development') === 'production' ? '127.0.0.1' : '0.0.0.0'),
    name: process.env.APP_NAME ?? 'iRexPro API',
    version: process.env.APP_VERSION ?? '0.1.0',
    env: process.env.NODE_ENV ?? 'development',
    apiPrefix: process.env.API_PREFIX ?? 'api/v1',
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
    // Sprint 28: base URL of the web app, used to build password reset links.
    // e.g. https://irexpro.lightworldtech.com
    // All reset links (web + admin) use this single base URL — admin users
    // reset via the web reset page, then log in to the admin portal.
    webBaseUrl: process.env.WEB_BASE_URL,
    // Sprint 28 amendment: admin base URL (for future admin-specific reset
    // links if needed). Currently reset links point to the web app for all
    // users — admin forgot-password calls the same endpoint and shows a
    // generic message pointing users to the web reset page.
    adminBaseUrl: process.env.ADMIN_BASE_URL,
  },
  // Sprint 28 amendment: email provider config. When EMAIL_SMTP_URL is set,
  // the delivery service uses nodemailer to send real reset/verification emails.
  email: {
    smtpUrl: process.env.EMAIL_SMTP_URL,
    fromAddress: process.env.EMAIL_FROM ?? process.env.EMAIL_FROM_ADDRESS ?? 'no-reply@irexpro.com',
  },
  sms: {
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      apiKey: process.env.TWILIO_API_KEY,
      apiSecret: process.env.TWILIO_API_SECRET,
      fromNumber: process.env.TWILIO_FROM_NUMBER,
    },
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    accessExpiry: process.env.JWT_ACCESS_EXPIRY ?? '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY ?? '7d',
  },
  // AppModule loads this root configuration object (not auth.config.ts), so
  // auth-domain services must receive their validated runtime values here.
  auth: {
    argon2MemoryCost: parseInt(process.env.ARGON2_MEMORY_COST ?? '65536', 10),
    argon2TimeCost: parseInt(process.env.ARGON2_TIME_COST ?? '3', 10),
    argon2Parallelism: parseInt(process.env.ARGON2_PARALLELISM ?? '1', 10),
    mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY,
    verificationPepper: process.env.AUTH_VERIFICATION_PEPPER,
  },
  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    name: process.env.DB_NAME ?? 'irexpro_dev',
    user: process.env.DB_USER ?? 'irexpro',
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true',
    synchronize: process.env.DB_SYNCHRONIZE === 'true',
    logging: process.env.DB_LOGGING === 'true',
    maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS ?? '10', 10),
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB ?? '0', 10),
    keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'irexpro:',
  },
  swagger: {
    enabled: process.env.SWAGGER_ENABLED !== 'false',
    path: process.env.SWAGGER_PATH ?? 'api/docs',
    title: process.env.SWAGGER_TITLE ?? 'iRexPro API',
    description: process.env.SWAGGER_DESCRIPTION ?? 'iRexPro Global AI Forex Trading Platform',
    version: process.env.SWAGGER_VERSION ?? '0.1.0',
  },
  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL ?? '60', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  },
  cookie: {
    secret: process.env.COOKIE_SECRET,
  },
  broker: {
    encryptionKey: process.env.BROKER_ENCRYPTION_KEY,
    metaApiToken: process.env.METAAPI_TOKEN,
    // Sprint 56 / Task 48-B — platform cTrader Open API app credentials.
    // OPTIONAL: without them the cTrader adapter still registers (the catalog
    // stays truthful) but connections fail closed with a clear
    // AUTHENTICATION_FAILED configuration message. NEVER log these values.
    ctraderClientId: process.env.CTRADER_CLIENT_ID,
    ctraderClientSecret: process.env.CTRADER_CLIENT_SECRET,
    // Sprint 56 correction round 1 (audit point 6) — the platform's
    // registered OAuth redirect URI(s), comma-separated (web callback page
    // and, if registered by the operator, the mobile deep-link scheme).
    // The user-facing OAuth flow fails closed when empty.
    ctraderRedirectUris: process.env.CTRADER_REDIRECT_URIS,
    // Sprint 56 correction round 2 (architect finding 4) — the HTTPS SERVER
    // callback slot URI(s) registered on the platform cTrader Open API
    // application for MOBILE flows, comma-separated. Each slot URI is
    // distinct (e.g. …/oauth/callback/m1 … /mN); authorize(channel=mobile)
    // atomically claims a free slot (a single configured slot serializes
    // mobile authorizations platform-wide — register more for parallelism).
    // Mobile authorizations fail closed when empty.
    ctraderMobileCallbackUris: process.env.CTRADER_MOBILE_CALLBACK_URIS,
    // Sprint 56 correction round 2 (architect finding 4) — the controlled
    // deep link the server callback redirects to after exchanging the
    // provider code (the app receives ONLY the one-time handoff token).
    ctraderMobileDeepLink: process.env.CTRADER_MOBILE_DEEP_LINK ?? 'irexpro://broker/oauth/handoff',
  },
  internalApi: {
    key: process.env.NESTJS_INTERNAL_API_KEY,
  },
  aiEngine: {
    baseUrl: process.env.AI_ENGINE_BASE_URL ?? 'http://localhost:8001/api/v1',
    schedulerEnabled: process.env.AI_ENGINE_SCHEDULER_ENABLED === 'true',
  },
  paystack: {
    // Fail-closed by default — PAYSTACK_ENABLED must be explicitly 'true' to
    // allow live checkout/webhook verification. Never log this secret.
    enabled: process.env.PAYSTACK_ENABLED === 'true',
    secretKey: process.env.PAYSTACK_SECRET_KEY || undefined,
    // Public key is safe to expose to clients if ever needed; not used server-side.
    publicKey: process.env.PAYSTACK_PUBLIC_KEY || undefined,
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET || undefined,
    baseUrl: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
    callbackUrl: process.env.PAYSTACK_CALLBACK_URL || undefined,
  },
  stripe: {
    // Fail-closed by default — STRIPE_ENABLED must be explicitly 'true' to
    // allow live checkout/webhook verification. Never log this secret.
    enabled: process.env.STRIPE_ENABLED === 'true',
    secretKey: process.env.STRIPE_SECRET_KEY || undefined,
    // Publishable key is safe to expose to clients if ever needed; not used server-side.
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || undefined,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || undefined,
    baseUrl: process.env.STRIPE_BASE_URL || 'https://api.stripe.com',
    successUrl: process.env.STRIPE_SUCCESS_URL || undefined,
    cancelUrl: process.env.STRIPE_CANCEL_URL || undefined,
  },
});
