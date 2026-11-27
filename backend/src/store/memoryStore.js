// In-memory store (automated tests) and the base of the JSON-file store (local PC).
// Same interface as dynamoStore.js and postgresStore.js:
//   get(id) | create(item) | update(item, expectedVersion) | remove(id) | scan() | queryBy(attr, value)
const { AppError } = require('../lib/http');

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function versionConflict() {
  return new AppError(409, 'VERSION_CONFLICT', 'This record was changed by someone else. Reload and try again.');
}

function createMemoryTable(def, data = new Map(), onChange = () => {}) {
  return {
    async get(id) { return clone(data.get(id)); },
    async create(item) {
      if (data.has(item.id)) throw versionConflict();
      const saved = { ...clone(item), version: 1 };
      data.set(item.id, saved);
      onChange();
      return clone(saved);
    },
    async update(item, expectedVersion) {
      const current = data.get(item.id);
      if (!current || current.version !== expectedVersion) throw versionConflict();
      const saved = { ...clone(item), version: expectedVersion + 1 };
      data.set(item.id, saved);
      onChange();
      return clone(saved);
    },
    async remove(id) { const existed = data.delete(id); onChange(); return existed; },
    async scan() { return [...data.values()].map(clone); },
    async queryBy(attr, value) {
      if (!def.indexes[attr]) throw new Error(`No index on ${def.name}.${attr}`);
      return [...data.values()].filter((item) => item[attr] === value).map(clone);
    }
  };
}

function createMemoryStore(schema) {
  const tables = {};
  for (const [key, def] of Object.entries(schema)) tables[key] = createMemoryTable(def);
  return { kind: 'memory', tables };
}

module.exports = { createMemoryStore, createMemoryTable, versionConflict };
