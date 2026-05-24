'use strict';

const fs = require('fs');
const path = require('path');
const { getPool } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Apply any unapplied .sql files under src/db/migrations/ in lexical order.
 * Returns { applied: string[], skipped: string[] }.
 */
async function runMigrations({ logger } = {}) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  const pool = getPool();
  if (!pool) {
    log.warn('runMigrations: DATABASE_URL not set; skipping migrations');
    return { applied: [], skipped: [] };
  }

  const files = listMigrationFiles();
  const result = { applied: [], skipped: [] };

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const appliedRes = await client.query('SELECT filename FROM schema_migrations');
    const already = new Set(appliedRes.rows.map((r) => r.filename));

    for (const file of files) {
      if (already.has(file)) {
        result.skipped.push(file);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      log.info(`applying migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations(filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [file],
        );
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }

  return result;
}

if (require.main === module) {
  runMigrations({ logger: console })
    .then((r) => {
      console.log(JSON.stringify({ applied: r.applied, skipped: r.skipped }, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('migration failed:', err.message);
      process.exit(1);
    });
}

module.exports = { runMigrations };
