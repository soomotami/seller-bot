'use strict';

const express = require('express');
const { getPool, endPool } = require('./db/pool');
const { runMigrations } = require('./db/migrate');
const { createTelegramRouter } = require('./telegram/webhook');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const AUTO_MIGRATE = (process.env.AUTO_MIGRATE || 'true').toLowerCase() !== 'false';

const startedAt = new Date().toISOString();

const log = {
  info: (...a) => ['debug', 'info'].includes(LOG_LEVEL) && console.log('[info]', ...a),
  warn: (...a) => ['debug', 'info', 'warn'].includes(LOG_LEVEL) && console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

const pool = getPool();
if (!pool) {
  log.warn('DATABASE_URL is not set; /health/ready will report db.status=unconfigured');
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

app.get('/health/live', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'sellernerve-api',
    env: NODE_ENV,
    startedAt,
    now: new Date().toISOString(),
  });
});

app.get('/health/ready', async (_req, res) => {
  const out = {
    status: 'ok',
    service: 'sellernerve-api',
    env: NODE_ENV,
    startedAt,
    now: new Date().toISOString(),
    checks: {
      db: { status: 'unknown' },
    },
  };

  const p = getPool();
  if (!p) {
    out.status = 'not_ready';
    out.checks.db = { status: 'unconfigured', detail: 'DATABASE_URL not set' };
    return res.status(503).json(out);
  }

  const t0 = Date.now();
  try {
    const r = await p.query('SELECT 1 AS ok');
    const ok = Array.isArray(r.rows) && r.rows.length === 1 && r.rows[0].ok === 1;
    out.checks.db = {
      status: ok ? 'ok' : 'failed',
      latencyMs: Date.now() - t0,
    };
    if (!ok) out.status = 'not_ready';
    return res.status(ok ? 200 : 503).json(out);
  } catch (err) {
    out.status = 'not_ready';
    out.checks.db = {
      status: 'failed',
      detail: err.code || err.name || 'pg_error',
      latencyMs: Date.now() - t0,
    };
    return res.status(503).json(out);
  }
});

app.use(createTelegramRouter({ logger: log }));

app.use((_req, res) => res.status(404).json({ status: 'not_found' }));

app.use((err, _req, res, _next) => {
  log.error('unhandled error:', err && err.message);
  res.status(500).json({ status: 'error' });
});

const server = app.listen(PORT, HOST, async () => {
  log.info(`sellernerve-api listening on http://${HOST}:${PORT} env=${NODE_ENV}`);
  if (AUTO_MIGRATE && getPool()) {
    try {
      const r = await runMigrations({ logger: log });
      if (r.applied.length) log.info(`migrations applied: ${r.applied.join(', ')}`);
      if (r.skipped.length) log.info(`migrations skipped: ${r.skipped.join(', ')}`);
    } catch (err) {
      log.error('auto-migrate failed:', err.message);
    }
  } else if (!AUTO_MIGRATE) {
    log.info('auto-migrate disabled (AUTO_MIGRATE=false)');
  }
});

function shutdown(signal) {
  log.info(`received ${signal}, shutting down`);
  server.close(() => {
    endPool().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
