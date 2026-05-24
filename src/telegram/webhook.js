'use strict';

const express = require('express');
const { getPool } = require('../db/pool');
const { handleCallbackQuery } = require('./handlers');
const { handleMessage } = require('./messages');
const { answerCallbackQuery } = require('./api');

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Express router that mounts POST /internal/telegram/webhook.
 *
 * Telegram security model:
 *   - We set a secret_token when calling setWebhook (TELEGRAM_WEBHOOK_SECRET).
 *   - Telegram sends it back in the `X-Telegram-Bot-Api-Secret-Token` header on every update.
 *   - If TELEGRAM_WEBHOOK_SECRET is set but the header is missing or mismatched, we reject 401.
 *   - If TELEGRAM_WEBHOOK_SECRET is not set, we accept any request (development mode) and log a warn.
 *
 * We always return 200 OK promptly to Telegram so it does not retry; processing errors are
 * captured into the callback_audit row and visible in logs.
 */
function createTelegramRouter({ logger } = {}) {
  const log = logger || console;
  const router = express.Router();

  router.post('/internal/telegram/webhook', async (req, res) => {
    const configured = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    if (configured) {
      const provided = req.get(SECRET_HEADER) || '';
      if (provided !== configured) {
        log.warn && log.warn('telegram webhook: secret header mismatch');
        return res.status(401).json({ ok: false, error: 'invalid_secret' });
      }
    } else {
      log.warn && log.warn('telegram webhook: TELEGRAM_WEBHOOK_SECRET not set (dev mode)');
    }

    const update = req.body || {};
    const updateId = update.update_id;
    const kind = update.callback_query
      ? 'callback_query'
      : update.message
        ? 'message'
        : 'other';
    log.info && log.info(`telegram update received: id=${updateId} kind=${kind}`);

    // Acknowledge to Telegram immediately, then process. Telegram only needs a 200.
    res.status(200).json({ ok: true });

    const pool = getPool();
    try {
      if (kind === 'callback_query') {
        const outcome = await handleCallbackQuery({ pool, update, logger: log });
        try {
          await answerCallbackQuery({
            callback_query_id: update.callback_query.id,
            text: outcome.toast || '',
            show_alert: !!outcome.alert,
          });
        } catch (err) {
          log.error && log.error('answerCallbackQuery failed:', err.message);
        }
        log.info && log.info(
          `callback handled: action=${outcome.parsed && outcome.parsed.action} ` +
          `reason=${outcome.reason} ` +
          `prev=${outcome.previousStatus || 'n/a'} new=${outcome.newStatus || 'n/a'}`
        );
      } else if (kind === 'message') {
        const outcome = await handleMessage({ pool, update, logger: log });
        log.info && log.info(
          `message handled: reason=${outcome.reason} chat_id=${outcome.chatId ? 'captured' : 'unknown'}`
        );
      } else {
        log.info && log.info('telegram update: kind not handled (no callback_query / message)');
      }
    } catch (err) {
      log.error && log.error('telegram webhook processing error:', err.message);
    }
  });

  return router;
}

module.exports = { createTelegramRouter, SECRET_HEADER };
