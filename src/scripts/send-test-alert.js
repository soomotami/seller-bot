'use strict';

/**
 * Create a minimal incident row and send a Telegram alert with the four required inline buttons:
 *   Проверяю / Статус / Пауза / Исправил
 *
 * chat_id resolution order:
 *   1. CLI arg `--chat-id=<id>` (override only).
 *   2. env TELEGRAM_TEST_CHAT_ID (optional override).
 *   3. Most recently captured chat in `telegram_chats`.
 *
 * The script never prints the bot token. If TELEGRAM_BOT_TOKEN is missing, it exits 2 with
 * a BLOCKED message naming only the env var. If no captured chat is found, it exits 3 and
 * tells you to open `t.me/${TELEGRAM_BOT_ADDRESS}` and press Start.
 */

const { getPool, endPool } = require('../db/pool');
const { runMigrations } = require('../db/migrate');
const { sendMessage, maskToken } = require('../telegram/api');
const { buildInlineKeyboard } = require('../telegram/buttons');
const { getLatestCapturedChatId } = require('../telegram/messages');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z0-9-]+)(?:=(.*))?$/i);
    if (!m) continue;
    out[m[1]] = m[2] == null ? true : m[2];
  }
  return out;
}

function fail(code, msg, extras = {}) {
  const payload = { ok: false, code, message: msg, ...extras };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary =
    args.summary || 'Test incident — Pass 2 Telegram callback proof';
  const kind = args.kind || 'test_alert';

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return fail(2, 'TELEGRAM_BOT_TOKEN is not set', {
      blocker: 'Set TELEGRAM_BOT_TOKEN via env/Devin Secrets and retry.',
    });
  }

  const pool = getPool();
  if (!pool) {
    return fail(4, 'DATABASE_URL is not set', {
      blocker: 'Set DATABASE_URL (see docker-compose.yml) and retry.',
    });
  }

  // Idempotent — safe if the server already migrated.
  await runMigrations({ logger: { info: () => {}, warn: () => {}, error: console.error } });

  let chatId = args['chat-id'] || process.env.TELEGRAM_TEST_CHAT_ID || null;
  let chatIdSource = chatId
    ? (args['chat-id'] ? 'cli_override' : 'env_override')
    : null;
  if (!chatId) {
    chatId = await getLatestCapturedChatId(pool);
    if (chatId) chatIdSource = 'captured_from_webhook';
  }
  if (!chatId) {
    const addr = process.env.TELEGRAM_BOT_ADDRESS
      ? `t.me/${process.env.TELEGRAM_BOT_ADDRESS.replace(/^@/, '')}`
      : 't.me/<TELEGRAM_BOT_ADDRESS>';
    return fail(3, 'No captured chat_id available', {
      blocker:
        `Open ${addr} and send /start to the bot, then re-run this script. ` +
        'Alternatively pass --chat-id=<id> or set TELEGRAM_TEST_CHAT_ID.',
    });
  }

  const ins = await pool.query(
    `INSERT INTO incidents (status, kind, summary)
     VALUES ('open', $1, $2)
     RETURNING id, status, kind, summary, created_at`,
    [kind, summary],
  );
  const incident = ins.rows[0];

  const text =
    `SellerNerve incident\n` +
    `id: ${incident.id}\n` +
    `kind: ${incident.kind}\n` +
    `status: ${incident.status}\n` +
    `summary: ${incident.summary}`;

  let sent;
  try {
    sent = await sendMessage({
      chat_id: chatId,
      text,
      reply_markup: buildInlineKeyboard(incident.id),
      disable_notification: false,
    });
  } catch (err) {
    return fail(5, `telegram sendMessage failed: ${err.message}`, {
      telegramError: err.telegramError || null,
      incidentId: incident.id,
      chatIdSource,
    });
  }

  const summaryOut = {
    ok: true,
    incidentId: incident.id,
    chatIdSource,
    chatIdMasked: maskChatId(chatId),
    messageId: sent.message_id,
    buttons: ['Проверяю', 'Статус', 'Пауза', 'Исправил'],
    tokenMasked: maskToken(process.env.TELEGRAM_BOT_TOKEN),
  };
  console.log(JSON.stringify(summaryOut, null, 2));
}

function maskChatId(id) {
  const s = String(id);
  if (s.length <= 4) return '***';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

main()
  .catch((err) => {
    console.error('[error]', err && err.stack ? err.stack : err);
    process.exit(1);
  })
  .finally(() => {
    endPool().catch(() => {});
  });
