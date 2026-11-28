// Logging and monitoring.
//  1. log()   -> one JSON line per event on stdout. On Lambda, stdout goes to
//               CloudWatch Logs automatically (/aws/lambda/<function-name>).
//  2. audit() -> security-relevant events (login, failed login, role change,
//               ownership violation...). Also written to the dedicated
//               CloudWatch log group AUDIT_LOG_GROUP (e.g. /tbx/audit).
// Passwords, tokens and Authorization headers are NEVER logged.
const config = require('../config');

const SENSITIVE = /pass(word)?|token|secret|authorization|data$/i;

function scrub(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
  }
  return out;
}

function log(level, message, fields = {}) {
  const line = JSON.stringify({
    time: new Date().toISOString(), level, message, ...scrub(fields)
  });
  if (process.env.LOG_SILENT === '1') return;
  if (level === 'error') console.error(line); else console.log(line);
}

// ---- CloudWatch audit trail -------------------------------------------------
let cw;
let streamReady;
const streamName = `${process.env.AWS_LAMBDA_FUNCTION_NAME || 'api-pc'}-${new Date().toISOString().slice(0, 10)}`;

function cloudWatch() {
  if (!cw) {
    const { CloudWatchLogsClient } = require('@aws-sdk/client-cloudwatch-logs');
    cw = new CloudWatchLogsClient({});
  }
  return cw;
}

async function ensureStream() {
  if (!streamReady) {
    const { CreateLogStreamCommand } = require('@aws-sdk/client-cloudwatch-logs');
    streamReady = cloudWatch()
      .send(new CreateLogStreamCommand({ logGroupName: config.auditLogGroup, logStreamName: streamName }))
      .catch((err) => {
        if (err.name !== 'ResourceAlreadyExistsException') { streamReady = null; throw err; }
      });
  }
  return streamReady;
}

const withTimeout = (promise, ms) => Promise.race([
  promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms).unref())
]);

// In-memory counters: exposed on GET /api/admin/stats as simple monitoring metrics
const metrics = { requests: 0, errors5xx: 0, errors4xx: 0, auditEvents: 0, securityEvents: 0, startedAt: new Date().toISOString() };

async function audit(action, details = {}, { security = false } = {}) {
  metrics.auditEvents += 1;
  if (security) metrics.securityEvents += 1;
  const entry = { action, ...details };
  log(security ? 'warn' : 'info', security ? 'SECURITY' : 'AUDIT', entry);
  if (!config.auditLogGroup) return;
  try {
    const { PutLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
    await withTimeout((async () => {
      await ensureStream();
      await cloudWatch().send(new PutLogEventsCommand({
        logGroupName: config.auditLogGroup,
        logStreamName: streamName,
        logEvents: [{ timestamp: Date.now(), message: JSON.stringify({ type: security ? 'SECURITY' : 'AUDIT', ...scrub(entry) }) }]
      }));
    })(), 2000);
  } catch (err) {
    log('warn', 'audit log write failed', { error: err.message });
  }
}

// Express middleware: request id + one access-log line per request
function requestLogger(req, res, next) {
  const started = Date.now();
  const requestId = require('crypto').randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    metrics.requests += 1;
    if (res.statusCode >= 500) metrics.errors5xx += 1;
    else if (res.statusCode >= 400) metrics.errors4xx += 1;
    log(res.statusCode >= 500 ? 'error' : 'info', 'request', {
      requestId,
      method: req.method,
      path: (req.originalUrl || req.url).split('?')[0],
      status: res.statusCode,
      durationMs: Date.now() - started,
      userId: req.user ? req.user.id : undefined,
      ip: req.ip
    });
  });
  next();
}

module.exports = { log, audit, requestLogger, metrics, scrub };
