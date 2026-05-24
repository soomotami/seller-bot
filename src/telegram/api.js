'use strict';

/**
 * Thin Telegram Bot API client. Uses the global `fetch` available on Node >= 18.
 *
 * The bot token is read from process.env.TELEGRAM_BOT_TOKEN at call time.
 * It is never logged. Errors do not include the token.
 */

const API_BASE = 'https://api.telegram.org';

function maskToken(token) {
  if (!token || token.length < 8) return '***';
  return `${token.slice(0, 4)}…${token.slice(-2)}`;
}

function requireToken() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) {
    const err = new Error('TELEGRAM_BOT_TOKEN is not set');
    err.code = 'TELEGRAM_BOT_TOKEN_MISSING';
    throw err;
  }
  return t;
}

async function callMethod(method, body, { timeoutMs = 10000 } = {}) {
  const token = requireToken();
  const url = `${API_BASE}/bot${token}/${method}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const wrapped = new Error(`telegram ${method} network error: ${err.message}`);
    wrapped.code = 'TELEGRAM_NETWORK_ERROR';
    wrapped.cause = err;
    throw wrapped;
  }
  clearTimeout(timer);

  let json;
  try {
    json = await res.json();
  } catch (_e) {
    const err = new Error(`telegram ${method} returned non-JSON (status=${res.status})`);
    err.code = 'TELEGRAM_BAD_RESPONSE';
    err.httpStatus = res.status;
    throw err;
  }

  if (!res.ok || !json || json.ok !== true) {
    const err = new Error(
      `telegram ${method} failed: ` +
        `status=${res.status} description=${(json && json.description) || 'unknown'}`,
    );
    err.code = 'TELEGRAM_API_ERROR';
    err.httpStatus = res.status;
    err.telegramError = json || null;
    throw err;
  }
  return json.result;
}

const getMe = () => callMethod('getMe', {});

const sendMessage = (params) => callMethod('sendMessage', params);

const answerCallbackQuery = (params) => callMethod('answerCallbackQuery', params);

const editMessageReplyMarkup = (params) => callMethod('editMessageReplyMarkup', params);

const setWebhook = (params) => callMethod('setWebhook', params);

const deleteWebhook = (params = {}) => callMethod('deleteWebhook', params);

const getWebhookInfo = () => callMethod('getWebhookInfo', {});

module.exports = {
  API_BASE,
  callMethod,
  getMe,
  sendMessage,
  answerCallbackQuery,
  editMessageReplyMarkup,
  setWebhook,
  deleteWebhook,
  getWebhookInfo,
  maskToken,
  requireToken,
};
