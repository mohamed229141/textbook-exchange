// Chooses the database. Services always import THIS file, so they never
// change when the storage changes.
//   STORAGE=dynamodb  (or DYNAMODB_TABLE_PREFIX set) -> DynamoDB on Floci / AWS
//   STORAGE=postgres  (or DATABASE_URL set)          -> Neon Postgres
//   STORAGE=json      (default on your PC)           -> backend/data/db.json
//   STORAGE=memory                                   -> automated tests
const config = require('../config');
const schema = require('./schema');
const { log } = require('../lib/logger');

let store;

function build(kind) {
  switch (kind) {
    case 'dynamodb': return require('./dynamoStore').createDynamoStore(schema, config.tablePrefix);
    case 'postgres': return require('./postgresStore').createPostgresStore(schema, config.databaseUrl);
    case 'memory': return require('./memoryStore').createMemoryStore(schema);
    case 'json':
      if (config.inLambda || process.env.VERCEL) {
        throw new Error('No database configured: set STORAGE=dynamodb (DYNAMODB_TABLE_PREFIX) or DATABASE_URL.');
      }
      return require('./jsonStore').createJsonStore(schema, config.jsonDataFile);
    default: throw new Error(`Unknown STORAGE "${kind}"`);
  }
}

function getStore() {
  if (!store) {
    store = build(config.storage);
    log('info', 'storage ready', { storage: store.kind, prefix: store.kind === 'dynamodb' ? config.tablePrefix : undefined });
  }
  return store;
}

// Tests: start from an empty in-memory database
function resetForTests() { store = build('memory'); return store; }

const tables = new Proxy({}, { get: (_, key) => getStore().tables[key] });

module.exports = { tables, getStore, resetForTests };
