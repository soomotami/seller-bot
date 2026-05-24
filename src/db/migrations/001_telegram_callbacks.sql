-- Pass 2 schema: minimal incident + action + callback audit tables.
-- All tables use IF NOT EXISTS so the migration is safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS incidents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text NOT NULL DEFAULT 'open',
  kind        text,
  summary     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS actions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id                uuid REFERENCES incidents(id) ON DELETE CASCADE,
  action_type                text NOT NULL,
  previous_status            text,
  new_status                 text,
  performed_by_tg_user_id    text,
  performed_by_tg_username   text,
  payload                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS callback_audit (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  callback_query_id   text NOT NULL UNIQUE,
  telegram_update_id  bigint,
  incident_id         uuid REFERENCES incidents(id) ON DELETE SET NULL,
  action_label        text,
  callback_data       text,
  tg_user_id          text,
  tg_username         text,
  chat_id             text,
  message_id          text,
  received_at         timestamptz NOT NULL DEFAULT now(),
  response_status     text,
  notes               text
);

CREATE INDEX IF NOT EXISTS idx_actions_incident_id      ON actions(incident_id);
CREATE INDEX IF NOT EXISTS idx_callback_audit_incident  ON callback_audit(incident_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status         ON incidents(status);

-- Telegram chats captured from incoming /start (or any message) updates.
-- We never receive chat_id from configuration: it is only captured at runtime
-- from incoming Telegram updates so that the test-alert script can target the
-- most recently active operator.

CREATE TABLE IF NOT EXISTS telegram_chats (
  chat_id       text PRIMARY KEY,
  chat_type     text,
  username      text,
  first_name    text,
  last_name     text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_text     text
);

CREATE INDEX IF NOT EXISTS idx_telegram_chats_last_seen
  ON telegram_chats(last_seen_at DESC);
