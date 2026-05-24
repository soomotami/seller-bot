# SellerNerve Devin Pass 2 Report — Telegram Send + Callback Loop

Date: 2026-05-24
Executor: Devin.ai
Branch: `devin/1779599394-pass-2-telegram-callbacks`
Builds on: Pass 1 (`/health/live`, `/health/ready`, Postgres readiness).

This report contains live PASS/FAIL evidence for the code paths and offline simulation, and a `BLOCKED` section for the live-Telegram round-trip which requires `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_ADDRESS` to be supplied via the Devin Secrets / environment.

`Secrets were not exposed.`

---

## 1. Scope completed

- [x] env-only configuration for `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_ADDRESS`, `TELEGRAM_WEBHOOK_SECRET`, `APP_BASE_URL`.
- [x] Webhook path: `POST /internal/telegram/webhook`.
- [x] `X-Telegram-Bot-Api-Secret-Token` header verification.
- [x] `/start` capture flow — chat_id is captured at runtime; no pre-known `TELEGRAM_TEST_CHAT_ID` is required.
- [x] Inline keyboard with all four buttons: `Проверяю`, `Статус`, `Пауза`, `Исправил`.
- [x] Callback handler for each button with `previous_status → new_status` transition.
- [x] Postgres evidence tables: `incidents`, `actions`, `callback_audit`, `telegram_chats`.
- [x] Replay safety: `callback_audit.callback_query_id UNIQUE` + `ON CONFLICT DO NOTHING` guarantees the second delivery of the same callback does not re-apply state.
- [x] Tunnel instructions for Cloudflare Tunnel, ngrok, and localtunnel.
- [x] PASS/FAIL evidence table with offline simulated round-trips.
- [x] No secret-bearing strings are logged, returned, or committed.

## 2. Files changed in Pass 2

```text
package.json                                       # version bump 0.1.0 → 0.2.0; new scripts
.env.example.sellernerve                           # added TELEGRAM_BOT_ADDRESS, AUTO_MIGRATE
src/server.js                                      # mounts telegram router, runs migrations on boot
src/db/pool.js                                     # NEW — singleton pg.Pool
src/db/migrate.js                                  # NEW — idempotent migration runner
src/db/migrations/001_telegram_callbacks.sql       # NEW — incidents/actions/callback_audit/telegram_chats
src/telegram/api.js                                # NEW — thin Telegram Bot API client
src/telegram/buttons.js                            # NEW — 4 inline buttons + callback_data parser
src/telegram/handlers.js                           # NEW — callback_query handler + transitions
src/telegram/messages.js                           # NEW — /start, /ping, chat_id capture
src/telegram/webhook.js                            # NEW — POST /internal/telegram/webhook router
src/scripts/send-test-alert.js                     # NEW — creates incident + sends alert
src/scripts/telegram-webhook.js                    # NEW — set/delete/info/me CLI
docs/devin/PASS_2_TELEGRAM_REPORT.md               # NEW — this report
```

## 3. Schema (migration `001_telegram_callbacks.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE incidents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status      text NOT NULL DEFAULT 'open',
  kind        text,
  summary     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE actions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id              uuid REFERENCES incidents(id) ON DELETE CASCADE,
  action_type              text NOT NULL,           -- checking | status | pause | fixed
  previous_status          text,
  new_status               text,
  performed_by_tg_user_id  text,
  performed_by_tg_username text,
  payload                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE callback_audit (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  callback_query_id  text NOT NULL UNIQUE,          -- idempotency key
  telegram_update_id bigint,
  incident_id        uuid REFERENCES incidents(id) ON DELETE SET NULL,
  action_label       text,                          -- 'Проверяю' etc.
  callback_data      text,                          -- 'inc:<id>:<action>'
  tg_user_id         text,
  tg_username        text,
  chat_id            text,
  message_id         text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  response_status    text,                          -- received | applied | unknown_incident
  notes              text
);

CREATE TABLE telegram_chats (
  chat_id       text PRIMARY KEY,                   -- captured at runtime
  chat_type     text,
  username      text,
  first_name    text,
  last_name     text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_text     text
);
```

Action → status mapping (canonical):

| Button     | Internal action | Resulting status      |
|------------|-----------------|------------------------|
| Проверяю  | `checking`      | `checking`             |
| Статус    | `status`        | *(unchanged — read-only)* |
| Пауза     | `pause`         | `paused`               |
| Исправил  | `fixed`         | `fixed_reported`       |

## 4. Webhook security

- Telegram is configured via `setWebhook` with `secret_token = TELEGRAM_WEBHOOK_SECRET`.
- Telegram sends the same value back on every update in the header `X-Telegram-Bot-Api-Secret-Token`.
- The router rejects (`HTTP 401 invalid_secret`) any request whose header is missing or does not match.
- If `TELEGRAM_WEBHOOK_SECRET` is unset, the router accepts requests but logs `[warn] telegram webhook: TELEGRAM_WEBHOOK_SECRET not set (dev mode)`. Production should always set the secret.
- The router always responds `200 {ok:true}` to Telegram quickly so it does not retry, then processes the update asynchronously. Errors are recorded in `callback_audit.response_status` / `callback_audit.notes` and stderr.

## 5. End-to-end live runbook

```bash
# --- 0. one-time env (do not commit) ---
export DATABASE_URL='postgresql://sellernerve:sellernerve@localhost:5432/sellernerve'
export TELEGRAM_BOT_TOKEN='***'                  # from @BotFather
export TELEGRAM_BOT_ADDRESS='SellerNerveBot'     # the bot @handle, no @
export TELEGRAM_WEBHOOK_SECRET="$(openssl rand -hex 32)"

# --- 1. start Postgres ---
docker compose up -d db

# --- 2. start API (auto-runs migrations on boot) ---
npm install
npm start   # listens on $PORT (default 3000)

# --- 3. expose API over public HTTPS (pick ONE) ---
# A) Cloudflare Tunnel (quick, no account needed for trycloudflare.com)
cloudflared tunnel --url http://localhost:3000
# Look for: "https://<random>.trycloudflare.com" — copy that.

# B) ngrok
ngrok http 3000
# Copy the "Forwarding https://<random>.ngrok-free.app" URL.

# C) localtunnel
npx localtunnel --port 3000
# Copy the "your url is: https://<random>.loca.lt" URL.

export APP_BASE_URL='https://<random>.trycloudflare.com'   # or ngrok/loca.lt URL

# --- 4. register the webhook with Telegram ---
npm run telegram:webhook:set
# Expected: { "ok": true, "action": "set", "url": "<APP_BASE_URL>/internal/telegram/webhook",
#             "secret_set": true, "result": true }
npm run telegram:webhook:info
# Expected: info.url matches, info.pending_update_count is small, last_error_message is null.

# --- 5. capture a chat_id by /start ---
# Open https://t.me/$TELEGRAM_BOT_ADDRESS (without the leading @) in any Telegram client
# and tap "Start". The webhook receives the message, the bot replies, and a row is
# upserted into `telegram_chats`.
docker exec sellernerve-db psql -U sellernerve -d sellernerve \
  -c "SELECT chat_id, username, last_seen_at::text FROM telegram_chats ORDER BY last_seen_at DESC LIMIT 5;"

# --- 6. send the test alert with all four buttons ---
npm run telegram:send-test-alert
# Expected output (chat_id masked, token masked):
# { "ok": true, "incidentId": "<uuid>", "chatIdSource": "captured_from_webhook",
#   "chatIdMasked": "42***42", "messageId": <int>,
#   "buttons": ["Проверяю","Статус","Пауза","Исправил"],
#   "tokenMasked": "1234…AB" }

# --- 7. press each button in Telegram and verify DB state ---
docker exec sellernerve-db psql -U sellernerve -d sellernerve -c "
  SELECT i.status AS incident_status,
         a.action_type, a.previous_status, a.new_status, a.created_at::text
  FROM incidents i LEFT JOIN actions a ON a.incident_id = i.id
  WHERE i.id = '<uuid-from-step-6>' ORDER BY a.created_at;"

docker exec sellernerve-db psql -U sellernerve -d sellernerve -c "
  SELECT callback_query_id, action_label, response_status, notes, received_at::text
  FROM callback_audit WHERE incident_id = '<uuid-from-step-6>' ORDER BY received_at;"
```

## 6. Offline simulation evidence (no live Telegram required)

The handler logic was verified end-to-end against the live local Postgres by posting hand-crafted update payloads to the running webhook, exactly as Telegram would. Token used was a non-functional dummy — `answerCallbackQuery` calls failed at the network step but did **not** prevent state persistence (which is the focus of Pass 2 evidence).

### 6.1 Webhook secret rejection

| Request                                                              | Result                |
|----------------------------------------------------------------------|------------------------|
| `POST /internal/telegram/webhook` — no `X-Telegram-Bot-Api-Secret-Token` | `HTTP 401 {ok:false,error:"invalid_secret"}` |
| `POST /internal/telegram/webhook` — header `WRONG`                   | `HTTP 401 {ok:false,error:"invalid_secret"}` |
| `POST /internal/telegram/webhook` — correct header                   | `HTTP 200 {ok:true}` |

### 6.2 chat_id capture from `/start`

```text
$ curl -X POST .../internal/telegram/webhook  -H 'X-Telegram-Bot-Api-Secret-Token: ***' \
       --data-binary '{"update_id":1,"message":{...,"chat":{"id":424242,...},"text":"/start"}}'
{"ok":true}

$ psql -c "SELECT chat_id, chat_type, username, first_name, last_text FROM telegram_chats;"
 chat_id | chat_type | username | first_name | last_text
---------+-----------+----------+------------+-----------
 424242  | private   | opuser   | Op         | /start
```

### 6.3 Four-button callback round-trip

```text
--- Проверяю ---  HTTP 200
--- Статус   ---  HTTP 200
--- Пауза    ---  HTTP 200
--- Исправил ---  HTTP 200
--- replay Проверяю (idempotency) ---  HTTP 200
--- bad action (unparsable) ---        HTTP 200
--- unknown incident ---               HTTP 200
```

API logs (token never appears):

```text
[info] telegram update received: id=300 kind=callback_query
[info] telegram update received: id=301 kind=callback_query
[info] telegram update received: id=302 kind=callback_query
[info] telegram update received: id=303 kind=callback_query
[info] telegram update received: id=300 kind=callback_query
[info] telegram update received: id=304 kind=callback_query
[warn] callback: unrecognized data shape
[info] telegram update received: id=305 kind=callback_query
[info] callback handled: action=checking reason=applied        prev=open           new=checking
[info] callback handled: action=status   reason=applied        prev=checking       new=checking
[info] callback handled: action=pause    reason=applied        prev=checking       new=paused
[info] callback handled: action=fixed    reason=applied        prev=paused         new=fixed_reported
[info] callback handled: action=checking reason=duplicate_callback prev=fixed_reported new=fixed_reported
[info] callback handled: action=undefined reason=unparsable_data    prev=n/a            new=n/a
[info] callback handled: action=checking reason=unknown_incident    prev=n/a            new=n/a
```

DB state after the simulated round-trip:

```text
-- incidents
 id                                   | status         | kind       | summary
--------------------------------------+----------------+------------+------------------------------------------------
 afea9ec1-8fb7-4de8-980b-ac4bdba9a6cf | fixed_reported | smoke_test | Smoke incident for Pass 2 webhook callback proof

-- actions (in order)
 action_type | previous_status | new_status
-------------+-----------------+----------------
 checking    | open            | checking
 status      | checking        | checking
 pause       | checking        | paused
 fixed       | paused          | fixed_reported

-- callback_audit
 callback_query_id | action_label | response_status  | notes
-------------------+--------------+------------------+----------------------------------------------------------
 cq-checking       | Проверяю     | applied          | previous=open new=checking action=checking
 cq-status         | Статус       | applied          | previous=checking new=checking action=status
 cq-pause          | Пауза        | applied          | previous=checking new=paused action=pause
 cq-fixed          | Исправил     | applied          | previous=paused new=fixed_reported action=fixed
 cq-unknown        | Проверяю     | unknown_incident | incident 00000000-0000-0000-0000-000000000000 not found
```

The replay of `cq-checking` (a redelivery from Telegram, same `callback_query_id`) did **not** add a new row — the `UNIQUE` constraint deduplicated it — and the incident status stayed at `fixed_reported`. This proves idempotency.

### 6.4 send-test-alert BLOCKED paths

| Scenario                                | Exit | Body                                                                                                  |
|-----------------------------------------|-----:|-------------------------------------------------------------------------------------------------------|
| `TELEGRAM_BOT_TOKEN` unset              | 2    | `{ok:false, code:2, message:"TELEGRAM_BOT_TOKEN is not set", blocker:"Set TELEGRAM_BOT_TOKEN via env/Devin Secrets and retry."}` |
| Token set, no captured chat             | 3    | `{ok:false, code:3, message:"No captured chat_id available", blocker:"Open t.me/SellerNerveBot and send /start to the bot, then re-run this script."}` |
| Token+chat OK, sendMessage 404 (dummy)  | 5    | `{ok:false, code:5, message:"telegram sendMessage failed: ...status=404 description=Not Found", incidentId:"<uuid>", chatIdSource:"captured_from_webhook"}` |

In all three paths the token value is never printed. Errors carry only HTTP status + Telegram's text `description`.

### 6.5 telegram-webhook script

```text
$ TELEGRAM_BOT_TOKEN='***' node src/scripts/telegram-webhook.js me
[error] telegram getMe failed: status=404 description=Not Found        # token is dummy here; token never echoed

$ TELEGRAM_BOT_TOKEN='***' node src/scripts/telegram-webhook.js set    # APP_BASE_URL not set
{"ok": false, "code": 2, "message": "APP_BASE_URL is not set"}

$ APP_BASE_URL='http://...' TELEGRAM_BOT_TOKEN='***' node src/scripts/telegram-webhook.js set
{"ok": false, "code": 2, "message": "APP_BASE_URL must start with https:// (Telegram requires HTTPS)"}
```

### 6.6 Live Telegram round-trip (`@signalptest_bot`)

Executed end-to-end against api.telegram.org in this session. Token-derived values are masked; only the bot's @handle (the documented `TELEGRAM_BOT_ADDRESS`) and operational identifiers (chat_id masked, incident UUID, callback_query_id, telegram_update_id) are shown.

**Setup**

```text
$ cloudflared tunnel --protocol http2 --url http://localhost:3000
Your quick Tunnel has been created!
https://events-ericsson-improving-hip.trycloudflare.com
... Registered tunnel connection ... protocol=http2

$ curl -s $APP_BASE_URL/health/live    # via tunnel
{"status":"ok",...} HTTP 200
$ curl -s $APP_BASE_URL/health/ready
{"status":"ok","checks":{"db":{"status":"ok","latencyMs":8}}} HTTP 200

$ npm run telegram:me
{ "ok": true, "me": { "id": 8907817070, "is_bot": true, "first_name": "SGT",
                       "username": "signalptest_bot", ... },
  "tokenMasked": "8907…vI" }

$ npm run telegram:webhook:set
{ "ok": true, "action": "set",
  "url": "https://events-ericsson-improving-hip.trycloudflare.com/internal/telegram/webhook",
  "secret_set": true, "result": true }

$ npm run telegram:webhook:info
{ "ok": true, "info": {
    "url": "https://events-ericsson-improving-hip.trycloudflare.com/internal/telegram/webhook",
    "pending_update_count": 0, "max_connections": 40,
    "allowed_updates": [ "message", "callback_query" ] } }
```

**Operator /start (chat captured by webhook)**

```text
$ psql -c "SELECT chat_type, username, first_name, last_text, last_seen_at::text FROM telegram_chats;"
 chat_type | username       | first_name | last_text | last_seen_at
-----------+----------------+------------+-----------+-------------------------------
 private   | gross_support  | Dm         | /start    | 2026-05-24 05:29:21.762+00
```

(chat_id is stored verbatim in the table — it's an operational identifier, not a secret. The `send-test-alert` script masks it on output.)

**Send test alert**

```text
$ npm run telegram:send-test-alert
{
  "ok": true,
  "incidentId": "20089153-562a-461b-8e58-1216160b2b6c",
  "chatIdSource": "captured_from_webhook",
  "chatIdMasked": "16***24",
  "messageId": 25,
  "buttons": ["Проверяю", "Статус", "Пауза", "Исправил"],
  "tokenMasked": "8907…vI"
}
```

The operator (`@gross_support`) then pressed each button in order. Server logs (token never appears):

```text
[info] telegram update received: id=475415119 kind=callback_query
[info] callback handled: action=checking reason=applied prev=open           new=checking
[info] telegram update received: id=475415120 kind=callback_query
[info] callback handled: action=status   reason=applied prev=checking       new=checking
[info] telegram update received: id=475415121 kind=callback_query
[info] callback handled: action=pause    reason=applied prev=checking       new=paused
[info] telegram update received: id=475415122 kind=callback_query
[info] callback handled: action=fixed    reason=applied prev=paused         new=fixed_reported
```

(No `[error] answerCallbackQuery` lines — each press also delivered a toast reply back to the user, confirming the full round-trip.)

**DB state — live round-trip**

```text
-- incidents
                  id                  |     status     |    kind    |          created_at
--------------------------------------+----------------+------------+-------------------------------
 20089153-562a-461b-8e58-1216160b2b6c | fixed_reported | test_alert | 2026-05-24 05:29:37.097289+00

-- actions (4 rows, ordered by created_at)
 action_type | previous_status |   new_status   | performed_by_tg_username
-------------+-----------------+----------------+--------------------------
 checking    | open            | checking       | gross_support
 status      | checking        | checking       | gross_support
 pause       | checking        | paused         | gross_support
 fixed       | paused          | fixed_reported | gross_support

-- callback_audit (4 rows, all applied)
 callback_query_id  | action_label | response_status | notes                                            | telegram_update_id
--------------------+--------------+-----------------+--------------------------------------------------+--------------------
 7265447099878276259 | Проверяю    | applied         | previous=open new=checking action=checking       |          475415119
 7265447096956301378 | Статус      | applied         | previous=checking new=checking action=status     |          475415120
 7265447097124339873 | Пауза       | applied         | previous=checking new=paused action=pause        |          475415121
 7265447097506758902 | Исправил    | applied         | previous=paused new=fixed_reported action=fixed  |          475415122
```

The four distinct `callback_query_id` values from Telegram are stored as-is, suitable for replay-deduplication via the `UNIQUE` constraint (proven in §6.3). The incident's final status `fixed_reported` matches the last button pressed.

## 7. PASS/FAIL summary (per acceptance criteria)

| Check                                                              | Result | Evidence |
|---------------------------------------------------------------------|--------|----------|
| API still passes `/health/live`                                     | PASS   | §6 logs + `curl /health/live → HTTP 200 status:"ok"` |
| API still passes `/health/ready` with Postgres                      | PASS   | `curl /health/ready → HTTP 200 status:"ok" checks.db.status:"ok"` |
| Telegram webhook endpoint exists                                    | PASS   | `POST /internal/telegram/webhook` in `src/telegram/webhook.js`; `npm run telegram:webhook:set` configures it |
| Telegram webhook rejects bad secret                                 | PASS   | §6.1 — 401 for missing/wrong header |
| Telegram test alert can be sent with all four buttons               | **PASS (live)** | §6.6 — live round-trip via `@signalptest_bot` over Cloudflare Tunnel: `send-test-alert` returned `{ok:true, incidentId:"20089153…", chatIdSource:"captured_from_webhook", chatIdMasked:"16***24", messageId:25}`. All 4 buttons rendered. |
| Callback `Проверяю` is received and changes status/action           | PASS   | §6.3 — `open → checking`; row in `actions`; row in `callback_audit` |
| Callback `Статус` returns current state without corrupting data     | PASS   | §6.3 — incident.status unchanged (`checking → checking`); action row records `previous=checking, new=checking` |
| Callback `Пауза` changes status/action (records pause intent)       | PASS   | §6.3 — `checking → paused` |
| Callback `Исправил` changes status/action to `fixed_reported`       | PASS   | §6.3 — `paused → fixed_reported` |
| Callback events are observable in DB/logs without secrets           | PASS   | §6.3 — `callback_audit` table; logs contain no token; chat IDs are stored, not redacted (they are operational identifiers, not secrets) |
| Idempotency: replay of same callback does not re-apply state        | PASS   | §6.3 — `cq-checking` replay logged as `duplicate_callback`, no extra row, status unchanged |
| Unknown-incident callbacks do not crash                             | PASS   | §6.3 — `unknown_incident` row, FK skipped |
| No secrets exposed in logs / DB / report / commits                  | PASS   | Token only ever sourced from `process.env.TELEGRAM_BOT_TOKEN`; `maskToken()` used wherever a token-derived value would otherwise appear |

## 8. Live-proof inputs (now satisfied)

The live round-trip in §6.6 was performed in this Devin session after the operator provided the inputs below. They are listed here so future sessions can reproduce it.

| Input                  | How it was provided in this session                                                            |
|------------------------|------------------------------------------------------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`   | Devin Secrets — temporary, session-only. Never printed; only accessed via `process.env`.       |
| `TELEGRAM_BOT_ADDRESS` | Devin Secrets — `signalptest_bot` (bot's @handle, no `@`). Used only in docs / error messages. |
| Public HTTPS URL       | `cloudflared tunnel --protocol http2 --url http://localhost:3000` → `APP_BASE_URL=https://events-ericsson-improving-hip.trycloudflare.com` (quick-Tunnel, ephemeral). |
| Operator /start        | Operator opened `t.me/signalptest_bot` and tapped **Start**; `telegram_chats` row was upserted by the webhook (`username=gross_support`, `chat_type=private`).        |

`TELEGRAM_TEST_CHAT_ID` is **not** required for live proof. It exists only as an optional override for non-interactive automation.

## 9. Out of scope (per Pass 2 brief)

- No WB token implementation.
- No Ozon code.
- No dashboard.
- No billing.
- No broad marketplace abstraction.
- No production deployment (only the local tunnel for the webhook proof).

## 10. Next pass recommendation

Pass 3 — Wildberries token validation: implement `/api/v1/seller-info` and `/ping` probes per `docs/devin/WB_API_PROOF_PLAN.md`, with both valid and invalid token cases. The seed PR #1 (`docs(devin): WB sandbox notes + WB-first proof plan`) already contains the WB plan and acceptance criteria.

## 11. SellerNerve Devin Pass Report

```text
SellerNerve Devin Pass Report

Pass: 2
Scope completed:
- POST /internal/telegram/webhook with secret-header verification
- inline keyboard with Проверяю / Статус / Пауза / Исправил
- callback handlers with idempotency and unknown-incident handling
- chat_id capture from /start (no pre-known chat_id required)
- send-test-alert script with structured BLOCKED outputs
- DB tables: incidents, actions, callback_audit, telegram_chats
- tunnel instructions (cloudflared / ngrok / localtunnel)
- evidence captured in DB rows + safe logs

Commands run:
- docker compose up -d db
- node src/db/migrate.js
- npm start
- curl POST /internal/telegram/webhook ...   (secret rejection)
- curl POST /internal/telegram/webhook ...   (/start capture)
- curl POST /internal/telegram/webhook ...   (4 buttons + replay + negatives)
- TELEGRAM_BOT_TOKEN='***' node src/scripts/send-test-alert.js
- TELEGRAM_BOT_TOKEN='***' node src/scripts/telegram-webhook.js {me,info,set}

Results:
- API health:        PASS
- DB readiness:      PASS
- Telegram send:     PASS (live — @signalptest_bot via cloudflared, message_id 25)
- Telegram callbacks: PASS (Проверяю / Статус / Пауза / Исправил all applied live; idempotent on replay)
- WB valid token:    N/A
- WB invalid token:  N/A

Changed files:
- see §2

Evidence:
- see §6 (DB rows + logs); §7 (PASS/FAIL table)

Blockers:
- None. Live round-trip completed in this session against @signalptest_bot (see §6.6).

Next pass recommendation:
- Pass 3 — WB token validation per docs/devin/WB_API_PROOF_PLAN.md.

Secrets were not exposed.
```
