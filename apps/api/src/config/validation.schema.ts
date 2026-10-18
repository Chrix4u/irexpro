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

  MFA_ENCRYPTION_KEY: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(32).optional().allow(''),
  }),

  AUTH_VERIFICATION_PEPPER: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(32).optional().allow(''),
  }),

  BROKER_ENCRYPTION_KEY: Joi.string().min(32).required(),
  METAAPI_TOKEN: Joi.string().optional().allow(''),
  IREXPRO_ALLOW_LIVE_CERTIFICATION: Joi.string().valid('true', 'false').optional().allow(''),

  CTRADER_CLIENT_ID: Joi.string().optional().allow(''),
  CTRADER_CLIENT_SECRET: Joi.string().optional().allow(''),
  CTRADER_APP_APPROVAL_STATUS: Joi.string()
    .valid('unknown', 'pending', 'active')
    .optional()
    .allow(''),
  CTRADER_REDIRECT_URIS: Joi.string().optional().allow(''),
  CTRADER_MOBILE_CALLBACK_URIS: Joi.string().optional().allow(''),
  CTRADER_MOBILE_DEEP_LINK: Joi.string().optional().allow(''),

  NESTJS_INTERNAL_API_KEY: Joi.string().optional().allow(''),

  EXTERNAL_SIGNAL_PROVIDER_ENABLED: Joi.string().valid('true', 'false').optional().allow(''),
  EXTERNAL_SIGNAL_PROVIDER_KEY: Joi.when('EXTERNAL_SIGNAL_PROVIDER_ENABLED', {
    is: 'true',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(32).optional().allow(''),
  }),

  TRADINGVIEW_WEBHOOK_ENABLED: Joi.string().valid('true', 'false').optional().allow(''),
  TRADINGVIEW_WEBHOOK_USER_ID: Joi.when('TRADINGVIEW_WEBHOOK_ENABLED', {
    is: 'true',
    then: Joi.string()
      .guid({ version: ['uuidv4'] })
      .required(),
    otherwise: Joi.string()
      .guid({ version: ['uuidv4'] })
      .optional()
      .allow(''),
  }),

  VPS_FOREX_SCANNER_ENABLED: Joi.string().valid('true', 'false').optional().allow(''),
  TWELVEDATA_API_KEY: Joi.when('VPS_FOREX_SCANNER_ENABLED', {
    is: 'true',
    then: Joi.string().min(8).invalid('demo').required(),
    otherwise: Joi.string().min(4).optional().allow(''),
  }),
  VPS_FOREX_SCANNER_USER_ID: Joi.when('VPS_FOREX_SCANNER_ENABLED', {
    is: 'true',
    then: Joi.string()
      .guid({ version: ['uuidv4'] })
      .required(),
    otherwise: Joi.string()
      .guid({ version: ['uuidv4'] })
      .optional()
      .allow(''),
  }),
  VPS_FOREX_SCANNER_BROKER_CONNECTION_ID: Joi.when('VPS_FOREX_SCANNER_ENABLED', {
    is: 'true',
    then: Joi.string()
      .guid({ version: ['uuidv4'] })
      .required(),
    otherwise: Joi.string()
      .guid({ version: ['uuidv4'] })
      .optional()
      .allow(''),
  }),
  M1_TACTICAL_MARKET_DATA_CONNECTION_ID: Joi.string()
    .guid({ version: ['uuidv4'] })
    .optional()
    .allow(''),
  M1_TACTICAL_CTRADER_COLLECTION_ENABLED: Joi.string()
    .valid('true', 'false')
    .optional()
    .allow(''),
  M1_TACTICAL_CTRADER_COLLECTION_INTERVAL_MS: Joi.number()
    .integer()
    .min(10_000)
    .max(300_000)
    .optional(),
  M1_TACTICAL_CTRADER_INSTRUMENTS: Joi.string().optional().allow(''),

  MULTIMODEL_BROKER_EXPERT_ENABLED: Joi.string().valid('true', 'false').optional().allow(''),
  MULTIMODEL_BROKER_EXPERT_SOURCE_CONNECTION_ID: Joi.when('MULTIMODEL_BROKER_EXPERT_ENABLED', {
    is: 'true',
    then: Joi.string()
      .guid({ version: ['uuidv4'] })
      .required(),
    otherwise: Joi.string()
      .guid({ version: ['uuidv4'] })
      .optional()
      .allow(''),
  }),

  AI_ENGINE_BASE_URL: Joi.string().default('http://localhost:8001/api/v1'),
  AI_ENGINE_SCHEDULER_ENABLED: Joi.boolean().default(false),

  PAYSTACK_ENABLED: Joi.boolean().default(false),
  PAYSTACK_SECRET_KEY: Joi.string().optional().allow(''),
  PAYSTACK_PUBLIC_KEY: Joi.string().optional().allow(''),
  PAYSTACK_WEBHOOK_SECRET: Joi.string().optional().allow(''),
  PAYSTACK_BASE_URL: Joi.string().default('https://api.paystack.co'),
  PAYSTACK_CALLBACK_URL: Joi.string().optional().allow(''),

  STRIPE_ENABLED: Joi.boolean().default(false),
  STRIPE_SECRET_KEY: Joi.string().optional().allow(''),
  STRIPE_PUBLISHABLE_KEY: Joi.string().optional().allow(''),
  STRIPE_WEBHOOK_SECRET: Joi.string().optional().allow(''),
  STRIPE_BASE_URL: Joi.string().default('https://api.stripe.com'),
  STRIPE_SUCCESS_URL: Joi.string().optional().allow(''),
  STRIPE_CANCEL_URL: Joi.string().optional().allow(''),

  WEB_BASE_URL: Joi.string().optional().allow(''),
  ADMIN_BASE_URL: Joi.string().optional().allow(''),
  EMAIL_SMTP_URL: Joi.string().optional().allow(''),
  EMAIL_FROM: Joi.string().optional().allow(''),
  EMAIL_FROM_ADDRESS: Joi.string().optional().allow(''),

  TWILIO_ACCOUNT_SID: Joi.string().optional().allow(''),
  TWILIO_AUTH_TOKEN: Joi.string().optional().allow(''),
  TWILIO_API_KEY: Joi.string().optional().allow(''),
  TWILIO_API_SECRET: Joi.string().optional().allow(''),
  TWILIO_FROM_NUMBER: Joi.string().optional().allow(''),
});
