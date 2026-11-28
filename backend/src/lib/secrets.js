// Where the JWT signing secret comes from (never from the code or the repo):
//   SECRETS_ID set  -> AWS Secrets Manager secret (JSON: {"jwtSecret":"..."}) - Floci / AWS
//   JWT_SECRET set  -> backend/.env (local PC) or Vercel environment variable
//   neither         -> development only: a random secret per process (tokens die on restart)
const crypto = require('crypto');
const config = require('../config');
const { log } = require('./logger');

let cached;

async function loadFromSecretsManager() {
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});
  const out = await client.send(new GetSecretValueCommand({ SecretId: config.secretsId }));
  const parsed = JSON.parse(out.SecretString || '{}');
  if (!parsed.jwtSecret || parsed.jwtSecret.length < 32) {
    throw new Error(`Secret ${config.secretsId} has no jwtSecret of at least 32 characters.`);
  }
  log('info', 'JWT secret loaded from Secrets Manager', { secretId: config.secretsId });
  return parsed.jwtSecret;
}

async function getJwtSecret() {
  if (cached) return cached;
  cached = (async () => {
    if (config.secretsId) return loadFromSecretsManager();
    if (config.jwtSecretFromEnv) {
      if (config.jwtSecretFromEnv.length < 32) throw new Error('JWT_SECRET must be at least 32 characters.');
      return config.jwtSecretFromEnv;
    }
    if (config.isProduction) throw new Error('No JWT secret configured (set SECRETS_ID or JWT_SECRET).');
    log('warn', 'No JWT secret configured: using a random development secret (tokens reset on restart).');
    return crypto.randomBytes(48).toString('hex');
  })();
  try {
    return await cached;
  } catch (err) {
    cached = null; // retry on the next request instead of caching the failure
    throw err;
  }
}

module.exports = { getJwtSecret };
