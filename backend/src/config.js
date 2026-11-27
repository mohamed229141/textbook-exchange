// Central configuration. Every value comes from environment variables
// (backend/.env on your PC, Lambda environment on Floci/AWS, Vercel settings).
// NOTHING secret has a default here: secrets come from Secrets Manager or .env.
require('dotenv').config({ quiet: true });

const list = (value, fallback) => (value || fallback || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const env = process.env;
const inLambda = Boolean(env.AWS_LAMBDA_FUNCTION_NAME);
const isProduction = env.NODE_ENV === 'production';

function pickStorage() {
  if (env.STORAGE) return env.STORAGE.trim().toLowerCase();
  if ((env.DATABASE_URL || '').trim()) return 'postgres';
  if ((env.DYNAMODB_TABLE_PREFIX || '').trim()) return 'dynamodb';
  return 'json';
}

module.exports = {
  isProduction,
  inLambda,
  runtime: inLambda ? 'lambda' : (env.VERCEL ? 'vercel' : 'pc'),
  port: Number(env.PORT) || 3000,

  // Which routers this process exposes. On Floci each Lambda function only
  // serves its own service: identity | listings | requests | moderation | alerts.
  enabledServices: list(env.ENABLED_SERVICES, 'identity,listings,requests,moderation,alerts'),

  corsOrigins: list(env.CORS_ORIGINS, 'http://localhost:8080,http://localhost:4566'),

  storage: pickStorage(),
  tablePrefix: (env.DYNAMODB_TABLE_PREFIX || 'Tbx').trim(),
  databaseUrl: (env.DATABASE_URL || '').trim(),
  jsonDataFile: env.JSON_DATA_FILE || 'data/db.json',

  // Secrets
  secretsId: (env.SECRETS_ID || '').trim(),        // Secrets Manager secret name
  jwtSecretFromEnv: (env.JWT_SECRET || '').trim(), // local dev only
  tokenTtlSeconds: Number(env.TOKEN_TTL_SECONDS) || 2 * 60 * 60,

  // Identity rules
  allowedEmailDomains: list(env.ALLOWED_EMAIL_DOMAINS, ''),
  maxFailedLogins: 5,
  lockMinutes: 15,

  // Listing rules
  maxActiveListingsPerSeller: Number(env.MAX_ACTIVE_LISTINGS) || 15,
  maxPrice: 5000,
  maxRenewals: 1,
  photoBucket: (env.PHOTO_BUCKET || '').trim(),
  photoMaxBytes: 1024 * 1024,

  // Request rules
  maxPendingRequestsPerBuyer: Number(env.MAX_PENDING_REQUESTS) || 5,
  minOfferRatio: 0.5,
  reservationHours: Number(env.RESERVATION_HOURS) || 72,

  // Messaging / monitoring
  topicArn: (env.TOPIC_ARN || '').trim(),
  queueUrl: (env.QUEUE_URL || '').trim(),
  auditLogGroup: (env.AUDIT_LOG_GROUP || '').trim(),

  // External API
  googleBooksBaseUrl: env.GOOGLE_BOOKS_URL || 'https://www.googleapis.com',
  googleBooksApiKey: (env.GOOGLE_BOOKS_API_KEY || '').trim(),   // optional
  externalTimeoutMs: 4000,

  // Rate limits (per IP, per minute)
  rateLimitGeneral: Number(env.RATE_LIMIT_GENERAL) || 300,
  rateLimitAuth: Number(env.RATE_LIMIT_AUTH) || 20,
  rateLimitReports: Number(env.RATE_LIMIT_REPORTS) || 10
};
