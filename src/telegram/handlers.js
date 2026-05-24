'use strict';

const { ACTIONS, parseCallbackData, labelForAction } = require('./buttons');

/**
 * Map an action -> new incident status. `status` is read-only and keeps the existing status.
 */
const ACTION_TO_NEW_STATUS = Object.freeze({
  [ACTIONS.CHECKING]: 'checking',
  [ACTIONS.STATUS]:   null,
  [ACTIONS.PAUSE]:    'paused',
  [ACTIONS.FIXED]:    'fixed_reported',
});

const TOAST_BY_ACTION = Object.freeze({
  [ACTIONS.CHECKING]: 'Принято: проверяю',
  [ACTIONS.PAUSE]:    'Принято: пауза',
  [ACTIONS.FIXED]:    'Принято: исправил',
});

function safeStr(v) {
  return v == null ? null : String(v);
}

/**
 * Handle a single callback_query from Telegram.
 *
 * Returns { toast, ok, alert, reason } where:
 *   toast  — text to show in answerCallbackQuery
 *   alert  — boolean, whether to show as alert popup vs short toast
 *   ok     — true if processed, false if rejected (unknown payload / no DB)
 *   reason — short tag for the audit row
 *
 * Idempotency: callback_audit.callback_query_id has UNIQUE; ON CONFLICT DO NOTHING means a
 * replayed callback short-circuits without re-applying state changes.
 */
async function handleCallbackQuery({ pool, update, logger }) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  const cq = update && update.callback_query;
  if (!cq) {
    return { ok: false, toast: '', reason: 'no_callback_query' };
  }

  const parsed = parseCallbackData(cq.data);
  if (!parsed) {
    log.warn('callback: unrecognized data shape');
    return { ok: false, toast: 'Неизвестная кнопка', alert: false, reason: 'unparsable_data' };
  }
  const { incidentId, action } = parsed;

  if (!pool) {
    log.warn('callback: DATABASE_URL not configured; cannot persist audit/state');
    return {
      ok: false,
      toast: 'DB не настроена',
      alert: false,
      reason: 'no_db',
      parsed,
    };
  }

  const tgUserId    = safeStr(cq.from && cq.from.id);
  const tgUsername  = safeStr(cq.from && cq.from.username);
  const chatId      = safeStr(cq.message && cq.message.chat && cq.message.chat.id);
  const messageId   = safeStr(cq.message && cq.message.message_id);
  const updateId    = update.update_id != null ? Number(update.update_id) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const incidentRes = await client.query(
      'SELECT id, status FROM incidents WHERE id = $1',
      [incidentId],
    );

    if (incidentRes.rowCount === 0) {
      await client.query(
        `INSERT INTO callback_audit
           (callback_query_id, telegram_update_id, incident_id, action_label,
            callback_data, tg_user_id, tg_username, chat_id, message_id,
            response_status, notes)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, 'unknown_incident', $9)
         ON CONFLICT (callback_query_id) DO NOTHING`,
        [
          safeStr(cq.id),
          updateId,
          labelForAction(action),
          cq.data,
          tgUserId,
          tgUsername,
          chatId,
          messageId,
          `incident ${incidentId} not found`,
        ],
      );
      await client.query('COMMIT');
      return {
        ok: false,
        toast: 'Инцидент не найден',
        alert: true,
        reason: 'unknown_incident',
        parsed,
      };
    }
    const previousStatus = incidentRes.rows[0].status;

    const auditInsert = await client.query(
      `INSERT INTO callback_audit
         (callback_query_id, telegram_update_id, incident_id, action_label,
          callback_data, tg_user_id, tg_username, chat_id, message_id, response_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'received')
       ON CONFLICT (callback_query_id) DO NOTHING
       RETURNING id`,
      [
        safeStr(cq.id),
        updateId,
        incidentId,
        labelForAction(action),
        cq.data,
        tgUserId,
        tgUsername,
        chatId,
        messageId,
      ],
    );
    const isNewAudit = auditInsert.rowCount > 0;

    if (!isNewAudit) {
      // Duplicate callback (Telegram replay) — do not re-apply state.
      await client.query('COMMIT');
      return {
        ok: true,
        toast: action === ACTIONS.STATUS
          ? `Статус: ${previousStatus}`
          : 'Уже обработано',
        alert: false,
        reason: 'duplicate_callback',
        parsed,
        previousStatus,
        newStatus: previousStatus,
      };
    }

    let newStatus = previousStatus;
    if (action !== ACTIONS.STATUS) {
      const mapped = ACTION_TO_NEW_STATUS[action];
      if (mapped) newStatus = mapped;
      await client.query(
        'UPDATE incidents SET status=$1, updated_at=now() WHERE id=$2',
        [newStatus, incidentId],
      );
    }

    await client.query(
      `INSERT INTO actions
         (incident_id, action_type, previous_status, new_status,
          performed_by_tg_user_id, performed_by_tg_username, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        incidentId,
        action,
        previousStatus,
        newStatus,
        tgUserId,
        tgUsername,
        JSON.stringify({
          callback_query_id: cq.id,
          telegram_update_id: updateId,
          chat_id: chatId,
          message_id: messageId,
        }),
      ],
    );

    await client.query(
      `UPDATE callback_audit
          SET response_status = 'applied',
              notes = $2
        WHERE callback_query_id = $1`,
      [
        safeStr(cq.id),
        `previous=${previousStatus} new=${newStatus} action=${action}`,
      ],
    );

    await client.query('COMMIT');

    let toast;
    if (action === ACTIONS.STATUS) {
      toast = `Статус: ${newStatus}`;
    } else {
      toast = TOAST_BY_ACTION[action] || 'Принято';
    }

    return {
      ok: true,
      toast,
      alert: false,
      reason: 'applied',
      parsed,
      previousStatus,
      newStatus,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  handleCallbackQuery,
  ACTION_TO_NEW_STATUS,
  TOAST_BY_ACTION,
};
