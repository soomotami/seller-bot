'use strict';

const { Pool } = require('pg');

let cachedPool = null;
let cachedFor = null;

/**
 * Return a shared pg.Pool for the current DATABASE_URL, or null if unset.
 * The pool is cached per connection string so repeated calls share it.
 */
function getPool() {
  const url = process.env.DATABASE_URL || '';
  if (!url) return null;
  if (cachedPool && cachedFor === url) return cachedPool;
  if (cachedPool && cachedFor !== url) {
    try { cachedPool.end(); } catch (_e) { /* ignore */ }
  }
  cachedPool = new Pool({
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
  });
  cachedPool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[error] pg pool error:', err.message);
  });
  cachedFor = url;
  return cachedPool;
}

async function endPool() {
  if (cachedPool) {
    const p = cachedPool;
    cachedPool = null;
    cachedFor = null;
    await p.end();
  }
}

module.exports = { getPool, endPool };
