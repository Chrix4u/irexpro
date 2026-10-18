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
    webBaseUrl: process.env.WEB_BASE_URL,
    adminBaseUrl: process.env.ADMIN_BASE_URL,
  },
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
    ctraderClientId: process.env.CTRADER_CLIENT_ID,
    ctraderClientSecret: process.env.CTRADER_CLIENT_SECRET,
    // Operator-observed Spotware application state. Keep `pending` while the
    // Open API portal reports the app blocked/inactive; switch to `active`
    // only after provider approval is visible there.
    ctraderAppApprovalStatus: process.env.CTRADER_APP_APPROVAL_STATUS ?? 'unknown',
    ctraderRedirectUris: process.env.CTRADER_REDIRECT_URIS,
    ctraderMobileCallbackUris: process.env.CTRADER_MOBILE_CALLBACK_URIS,
    ctraderMobileDeepLink: process.env.CTRADER_MOBILE_DEEP_LINK ?? 'irexpro://broker/oauth/handoff',
    allowLiveCertification: process.env.IREXPRO_ALLOW_LIVE_CERTIFICATION === 'true',
  },
  internalApi: {
    key: process.env.NESTJS_INTERNAL_API_KEY,
  },
  externalSignals: {
    enabled: process.env.EXTERNAL_SIGNAL_PROVIDER_ENABLED === 'true',
    apiKey: process.env.EXTERNAL_SIGNAL_PROVIDER_KEY,
  },
  tradingViewWebhook: {
    enabled: process.env.TRADINGVIEW_WEBHOOK_ENABLED === 'true',
    userId: process.env.TRADINGVIEW_WEBHOOK_USER_ID,
  },
  vpsForexScanner: {
    enabled: process.env.VPS_FOREX_SCANNER_ENABLED === 'true',
    apiKey: process.env.TWELVEDATA_API_KEY,
    userId: process.env.VPS_FOREX_SCANNER_USER_ID,
    brokerConnectionId: process.env.VPS_FOREX_SCANNER_BROKER_CONNECTION_ID,
    fastMarkStreamEnabled: process.env.TWELVEDATA_FAST_MARK_STREAM_ENABLED !== 'false',
    // Optional read-only provider binding for the M1 tactical sleeve. PAPER
    // execution/evidence remains bound to brokerConnectionId.
    m1MarketDataConnectionId: process.env.M1_TACTICAL_MARKET_DATA_CONNECTION_ID,
    m1CtraderCollectionEnabled: process.env.M1_TACTICAL_CTRADER_COLLECTION_ENABLED === 'true',
    m1CtraderCollectionIntervalMs: parseInt(
      process.env.M1_TACTICAL_CTRADER_COLLECTION_INTERVAL_MS ?? '15000',
      10,
    ),
    m1CtraderCollectionInstruments:
      process.env.M1_TACTICAL_CTRADER_INSTRUMENTS ??
      'EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF',
  },
  brokerParityV7: {
    enabled: process.env.BROKER_PARITY_V7_ENABLED === 'true',
    signalExecutionEnabled: process.env.BROKER_PARITY_V7_SIGNAL_EXECUTION_ENABLED === 'true',
    userId: process.env.BROKER_PARITY_V7_USER_ID,
    sourceConnectionId: process.env.BROKER_PARITY_V7_SOURCE_CONNECTION_ID,
    paperConnectionId: process.env.BROKER_PARITY_V7_PAPER_CONNECTION_ID,
    artifactDigest: process.env.BROKER_PARITY_V7_ARTIFACT_DIGEST,
  },
  multimodelBrokerExpert: {
    enabled: process.env.MULTIMODEL_BROKER_EXPERT_ENABLED === 'true',
    sourceConnectionId: process.env.MULTIMODEL_BROKER_EXPERT_SOURCE_CONNECTION_ID,
  },
  v8DedicatedPaper: {
    enabled: process.env.V8_DEDICATED_PAPER_ENABLED === 'true',
    userId: process.env.V8_DEDICATED_PAPER_USER_ID,
    paperConnectionId: process.env.V8_DEDICATED_PAPER_CONNECTION_ID,
    artifactDigest: process.env.V8_DEDICATED_PAPER_ARTIFACT_DIGEST,
  },
  aiEngine: {
    baseUrl: process.env.AI_ENGINE_BASE_URL ?? 'http://localhost:8001/api/v1',
    schedulerEnabled: process.env.AI_ENGINE_SCHEDULER_ENABLED === 'true',
  },
  paystack: {
    enabled: process.env.PAYSTACK_ENABLED === 'true',
    secretKey: process.env.PAYSTACK_SECRET_KEY || undefined,
    publicKey: process.env.PAYSTACK_PUBLIC_KEY || undefined,
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET || undefined,
    baseUrl: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
    callbackUrl: process.env.PAYSTACK_CALLBACK_URL || undefined,
  },
  stripe: {
    enabled: process.env.STRIPE_ENABLED === 'true',
    secretKey: process.env.STRIPE_SECRET_KEY || undefined,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || undefined,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || undefined,
    baseUrl: process.env.STRIPE_BASE_URL || 'https://api.stripe.com',
    successUrl: process.env.STRIPE_SUCCESS_URL || undefined,
    cancelUrl: process.env.STRIPE_CANCEL_URL || undefined,
  },
});

export interface LiveCertificationConfigView {
  broker?: {
    allowLiveCertification?: boolean;
  };
}

export function isLiveCertificationEnabled(
  config: LiveCertificationConfigView | null | undefined,
): boolean {
  return config?.broker?.allowLiveCertification === true;
}
