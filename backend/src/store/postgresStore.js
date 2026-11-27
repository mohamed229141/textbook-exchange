// Neon (serverless Postgres) store: optional external database (DATABASE_URL).
// Each record is a JSONB document in one table; expression indexes make
// the "queryBy" lookups fast. Schema: backend/db/schema.sql
const { neon } = require('@neondatabase/serverless');
const { versionConflict } = require('./memoryStore');

function createPostgresStore(schema, databaseUrl) {
  const sql = neon(databaseUrl);
  const run = (text, params) => sql.query(text, params);

  const tables = {};
  for (const [key, def] of Object.entries(schema)) {
    const tbl = def.name;
    tables[key] = {
      async get(id) {
        const rows = await run('SELECT data FROM tbx_documents WHERE tbl = $1 AND id = $2', [tbl, id]);
        return rows[0] ? rows[0].data : undefined;
      },
      async create(item) {
        const saved = { ...item, version: 1 };
        const rows = await run(
          `INSERT INTO tbx_documents (tbl, id, version, data) VALUES ($1, $2, 1, $3::jsonb)
           ON CONFLICT (tbl, id) DO NOTHING RETURNING id`, [tbl, item.id, JSON.stringify(saved)]);
        if (!rows.length) throw versionConflict();
        return saved;
      },
      async update(item, expectedVersion) {
        const saved = { ...item, version: expectedVersion + 1 };
        const rows = await run(
          `UPDATE tbx_documents SET data = $4::jsonb, version = $5
           WHERE tbl = $1 AND id = $2 AND version = $3 RETURNING id`,
          [tbl, item.id, expectedVersion, JSON.stringify(saved), expectedVersion + 1]);
        if (!rows.length) throw versionConflict();
        return saved;
      },
      async remove(id) {
        await run('DELETE FROM tbx_documents WHERE tbl = $1 AND id = $2', [tbl, id]);
        return true;
      },
      async scan() {
        const rows = await run('SELECT data FROM tbx_documents WHERE tbl = $1', [tbl]);
        return rows.map((r) => r.data);
      },
      async queryBy(attr, value) {
        if (!def.indexes[attr]) throw new Error(`No index on ${tbl}.${attr}`);
        const rows = await run(
          'SELECT data FROM tbx_documents WHERE tbl = $1 AND data->>$2 = $3', [tbl, attr, String(value)]);
        return rows.map((r) => r.data);
      }
    };
  }
  return { kind: 'postgres', tables };
}

module.exports = { createPostgresStore };
