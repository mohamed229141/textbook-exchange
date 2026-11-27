// Local-PC store: the in-memory store saved to backend/data/db.json after each write.
// Only for development on your laptop (Lambda/Vercel disks are temporary).
const fs = require('fs');
const path = require('path');
const { createMemoryTable } = require('./memoryStore');

function createJsonStore(schema, file) {
  const fullPath = path.resolve(__dirname, '../..', file);
  let raw = {};
  if (fs.existsSync(fullPath)) {
    raw = JSON.parse(fs.readFileSync(fullPath, 'utf8') || '{}');
  }
  const maps = {};
  const save = () => {
    const out = {};
    for (const [key, map] of Object.entries(maps)) out[key] = [...map.values()];
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, JSON.stringify(out, null, 2));
  };
  const tables = {};
  for (const [key, def] of Object.entries(schema)) {
    maps[key] = new Map((raw[key] || []).map((item) => [item.id, item]));
    tables[key] = createMemoryTable(def, maps[key], save);
  }
  return { kind: 'json', tables };
}

module.exports = { createJsonStore };
