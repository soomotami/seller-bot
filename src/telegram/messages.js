'use strict';

const { sendMessage } = require('./api');

const START_REPLY = [
  'SellerNerve bot готов.',
  '',
  'Этот чат теперь зарегистрирован для тестовых алертов.',
  'Команды:',
  '  /start  — зарегистрировать чат',
  '  /ping   — проверка связи',
].join('\n');

const PING_REPLY = 'pong';

function safeStr(v) {
  return v == null ? null : String(v);
}

/**
 * Upsert a Telegram chat into telegram_chats. Returns { chatId, isNew }.
 * `last_text` stores only the first 256 chars of the incoming text so we never persist
 * unexpectedly large or sensitive payloads.
 */
async function upsertChat(pool, message) {
  if (!pool || !message || !message.chat) return { chatId: null, isNew: false };
  const chat = message.chat;
  const chatId = safeStr(chat.id);
  if (!chatId) return { chatId: null, isNew: false };

  const text = typeof message.text === 'string' ? message.text.slice(0, 256) : null;

  const res = await pool.query(
    `INSERT INTO telegram_chats
       (chat_id, chat_type, username, first_name, last_name, last_text, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (chat_id) DO UPDATE
       SET chat_type    = EXCLUDED.chat_type,
           username     = COALESCE(EXCLUDED.username,   telegram_chats.username),
           first_name   = COALESCE(EXCLUDED.first_name, telegram_chats.first_name),
           last_name    = COALESCE(EXCLUDED.last_name,  telegram_chats.last_name),
           last_text    = EXCLUDED.last_text,
           last_seen_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [
      chatId,
      safeStr(chat.type),
      safeStr(chat.username),
      safeStr(chat.first_name),
      safeStr(chat.last_name),
      text,
    ],
  );
  const isNew = res.rows[0] && res.rows[0].inserted === true;
  return { chatId, isNew };
}

/**
 * Handle a message update. Captures the chat in telegram_chats and replies to /start, /ping.
 * Other messages are recorded but not replied to (the bot is operator-facing, not a chatbot).
 */
async function handleMessage({ pool, update, logger }) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  const message = update && update.message;
  if (!message) return { ok: false, reason: 'no_message' };

  let capture = { chatId: null, isNew: false };
  if (pool) {
    try {
      capture = await upsertChat(pool, message);
    } catch (err) {
      log.error('telegram_chats upsert failed:', err.message);
    }
  } else {
    log.warn('handleMessage: DATABASE_URL not configured; skipping chat capture');
  }

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const chatId = capture.chatId || (message.chat && String(message.chat.id));

  if (text === '/start' || text.startsWith('/start ')) {
    if (chatId) {
      try {
        await sendMessage({ chat_id: chatId, text: START_REPLY });
      } catch (err) {
        log.error('telegram sendMessage(/start reply) failed:', err.message);
      }
    }
    return { ok: true, reason: 'start', chatId, isNew: capture.isNew };
  }
  if (text === '/ping') {
    if (chatId) {
      try {
        await sendMessage({ chat_id: chatId, text: PING_REPLY });
      } catch (err) {
        log.error('telegram sendMessage(/ping reply) failed:', err.message);
      }
    }
    return { ok: true, reason: 'ping', chatId };
  }

  return { ok: true, reason: 'captured', chatId, isNew: capture.isNew };
}

/**
 * Look up the most recently active captured chat (excluding any chat_id passed in `exclude`).
 */
async function getLatestCapturedChatId(pool) {
  if (!pool) return null;
  const res = await pool.query(
    'SELECT chat_id FROM telegram_chats ORDER BY last_seen_at DESC LIMIT 1',
  );
  return res.rowCount > 0 ? res.rows[0].chat_id : null;
}

module.exports = {
  handleMessage,
  upsertChat,
  getLatestCapturedChatId,
  START_REPLY,
  PING_REPLY,
};
