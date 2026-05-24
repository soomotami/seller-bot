'use strict';

/**
 * Canonical inline-keyboard buttons required by the Pass 2 acceptance criteria.
 *
 * `label` is what the user sees in Telegram.
 * `action` is a stable internal identifier used inside callback_data and stored in the audit row.
 * `callback_data` format: `inc:<incidentId>:<action>`. Telegram limits callback_data to 64 bytes —
 * with a uuid (36 bytes) plus `inc:` (4) plus action (max ~14) we stay well under the cap.
 */

const ACTIONS = Object.freeze({
  CHECKING: 'checking',
  STATUS: 'status',
  PAUSE: 'pause',
  FIXED: 'fixed',
});

const BUTTON_DEFINITIONS = Object.freeze([
  { label: 'Проверяю',  action: ACTIONS.CHECKING },
  { label: 'Статус',    action: ACTIONS.STATUS   },
  { label: 'Пауза',     action: ACTIONS.PAUSE    },
  { label: 'Исправил',  action: ACTIONS.FIXED    },
]);

function buildInlineKeyboard(incidentId) {
  const row = BUTTON_DEFINITIONS.map((b) => ({
    text: b.label,
    callback_data: `inc:${incidentId}:${b.action}`,
  }));
  return { inline_keyboard: [row] };
}

function parseCallbackData(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(':');
  if (parts.length !== 3 || parts[0] !== 'inc') return null;
  const [, incidentId, action] = parts;
  if (!incidentId || !action) return null;
  if (!BUTTON_DEFINITIONS.some((b) => b.action === action)) return null;
  return { incidentId, action };
}

function labelForAction(action) {
  const found = BUTTON_DEFINITIONS.find((b) => b.action === action);
  return found ? found.label : action;
}

module.exports = {
  ACTIONS,
  BUTTON_DEFINITIONS,
  buildInlineKeyboard,
  parseCallbackData,
  labelForAction,
};
