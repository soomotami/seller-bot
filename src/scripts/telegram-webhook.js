'use strict';

/**
 * CLI to set / delete / inspect the Telegram webhook.
 *
 * Usage:
 *   node src/scripts/telegram-webhook.js set      # uses APP_BASE_URL + TELEGRAM_WEBHOOK_SECRET
 *   node src/scripts/telegram-webhook.js delete
 *   node src/scripts/telegram-webhook.js info
 *   node src/scripts/telegram-webhook.js me
 *
 * Required env:
 *   TELEGRAM_BOT_TOKEN          (always)
 *   APP_BASE_URL                (for `set` — must be HTTPS, e.g. ngrok / cloudflared tunnel)
 *   TELEGRAM_WEBHOOK_SECRET     (recommended for `set`; required for production)
 *
 * Token is never printed. APP_BASE_URL is documented.
 */

const {
  setWebhook,
  deleteWebhook,
  getWebhookInfo,
  getMe,
  maskToken,
} = require('../telegram/api');

const WEBHOOK_PATH = '/internal/telegram/webhook';

function fail(code, msg, extras = {}) {
  console.error(JSON.stringify({ ok: false, code, message: msg, ...extras }, null, 2));
  process.exit(code);
}

async function cmdSet() {
  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) return fail(2, 'APP_BASE_URL is not set');
  if (!/^https:\/\//i.test(baseUrl)) {
    return fail(2, 'APP_BASE_URL must start with https:// (Telegram requires HTTPS)');
  }
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  const url = baseUrl.replace(/\/+$/, '') + WEBHOOK_PATH;

  const params = {
    url,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  };
  if (secret) params.secret_token = secret;

  const result = await setWebhook(params);
  console.log(
    JSON.stringify(
      {
        ok: true,
        action: 'set',
        url,
        secret_set: Boolean(secret),
        result,
      },
      null,
      2,
    ),
  );
}

async function cmdDelete() {
  const result = await deleteWebhook({ drop_pending_updates: true });
  console.log(JSON.stringify({ ok: true, action: 'delete', result }, null, 2));
}

async function cmdInfo() {
  const info = await getWebhookInfo();
  // info.url is safe (URL only); token is not in it.
  console.log(JSON.stringify({ ok: true, action: 'info', info }, null, 2));
}

async function cmdMe() {
  const me = await getMe();
  // me.username is the bot address; the token is not echoed.
  console.log(
    JSON.stringify(
      { ok: true, action: 'me', me, tokenMasked: maskToken(process.env.TELEGRAM_BOT_TOKEN) },
      null,
      2,
    ),
  );
}

async function main() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return fail(2, 'TELEGRAM_BOT_TOKEN is not set');
  }
  const cmd = process.argv[2] || 'info';
  switch (cmd) {
    case 'set':    return cmdSet();
    case 'delete': return cmdDelete();
    case 'info':   return cmdInfo();
    case 'me':     return cmdMe();
    default:
      return fail(2, `unknown command: ${cmd}`, {
        supported: ['set', 'delete', 'info', 'me'],
      });
  }
}

main().catch((err) => {
  console.error('[error]', err && err.message ? err.message : err);
  process.exit(1);
});
