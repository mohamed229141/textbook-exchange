// The Express app: middleware + the routes of the three services.
// It does NOT start a server. It is used by:
//   server.js  -> your PC (npm run dev) and Vercel
//   lambda.js  -> AWS Lambda behind API Gateway (Floci or real AWS)
const express = require('express');
const cors = require('cors');
const config = require('./src/config');
const { requestLogger, log } = require('./src/lib/logger');
const { rateLimit } = require('./src/lib/rateLimit');

// Load all services so their event handlers are wired up in every process,
// even when this process only exposes one service's routes (one Lambda per service).
require('./src/services/identity/identityService');
require('./src/services/listings/listingService');
require('./src/services/requests/requestService');
require('./src/services/moderation/moderationService');
require('./src/services/alerts/alertService');

const routers = {
  identity: () => require('./src/services/identity/identityRoutes'),
  listings: () => require('./src/services/listings/listingRoutes'),
  requests: () => require('./src/services/requests/requestRoutes'),
  moderation: () => require('./src/services/moderation/moderationRoutes'),
  alerts: () => require('./src/services/alerts/alertRoutes')
};

const app = express();
app.disable('x-powered-by');
// Behind API Gateway / Vercel the client IP is in X-Forwarded-For (first hop only)
app.set('trust proxy', config.inLambda || Boolean(process.env.VERCEL) ? 1 : false);

app.use(requestLogger);

// Security headers (the API only returns JSON)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// CORS: only our own website(s) may call the API from a browser (never "*")
app.use(cors({
  origin: config.corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['X-Request-Id', 'Location'],
  maxAge: 600
}));

app.use(express.json({ limit: '2mb' }));

// Same fix as Lab 7: some API Gateway emulators give Lambda the body as raw bytes / base64
app.use((req, res, next) => {
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
    const text = req.body.toString('utf8').trim();
    const decoded = /^[A-Za-z0-9+/=\s]+$/.test(text) && !text.startsWith('{')
      ? Buffer.from(text, 'base64').toString('utf8')
      : text;
    try {
      req.body = decoded ? JSON.parse(decoded) : {};
    } catch {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.' } });
    }
  }
  if (req.body === undefined || req.body === null) req.body = {};
  next();
});

app.use('/api', rateLimit({ name: 'general', max: config.rateLimitGeneral }));

app.get('/', (req, res) => {
  res.json({ name: 'Textbook Exchange API', services: config.enabledServices, health: '/api/health' });
});

// Health check: proves the deployment runs (no database call)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    runtime: config.runtime,
    storage: config.storage,
    services: config.enabledServices,
    function: process.env.AWS_LAMBDA_FUNCTION_NAME || null
  });
});

for (const name of config.enabledServices) {
  if (!routers[name]) throw new Error(`Unknown service in ENABLED_SERVICES: ${name}`);
  app.use('/api', routers[name]());
}

app.use((req, res) => {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.' } });
});

// Central error handler: known errors keep their status; anything else is a 500
// without internal details (the details go to the logs, with the request id).
// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.' } });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
  }
  if (error.status && error.code) {
    const body = { code: error.code, message: error.message };
    if (error.details) body.details = error.details;
    return res.status(error.status).json({ error: body });
  }
  log('error', 'unhandled error', { requestId: req.requestId, error: error.message, stack: error.stack });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.', requestId: req.requestId }
  });
});

module.exports = app;
