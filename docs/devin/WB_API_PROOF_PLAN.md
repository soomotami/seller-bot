# Wildberries API Proof Plan (Pass 3, WB-first)

Goal: prove SellerNerve can validate a Wildberries API token — accepting a valid token and rejecting an invalid one — using the smallest possible non-destructive surface and never exposing secrets.

This plan complements `docs/devin/WB_SANDBOX_NOTES.md`. Read that first.

## 1. First WB API surface used

Primary (production, read-only, mutation-free):

1. `GET https://common-api.wildberries.ru/ping`
   - WB "Connection Check". Returns `200 {"TS": "...","Status":"OK"}` for any valid token category.
   - Rate limit: 3 requests / 30 seconds per host per method.
2. `GET https://common-api.wildberries.ru/api/v1/seller-info`
   - Returns `200 {"name":"<seller name>","sid":"<uuid>","tin":"<tin>","tradeMark":"<brand>"}`.
   - Proves the token is actually bound to a real WB seller (`sid`).
   - Rate limit: 1 request/minute (Personal/Service/Base-with-secret); 1 request/24h (Base).

Both endpoints:
- Are documented at <https://dev.wildberries.ru/en/docs/openapi/api-information>.
- Accept a token of any category (Personal/Service/Base/Test) — but Test scope tokens only resolve against `*-sandbox.wildberries.ru`, where there is no `common-api` host.
- Are GET-only and read-only.

Sandbox fallback (only useful if owner refuses a production token and instead provides a Test scope token):

- `GET https://content-api-sandbox.wildberries.ru/ping` (or any other sandbox host's `/ping`).
  - Confirms the token is syntactically valid, recognized by WB sandbox, and scoped correctly.
  - Does **not** return seller identity (no `common-api-sandbox`).

## 2. Test modes

Three modes are supported. The selected mode is determined by which env vars are present at proof time. None of the modes ever requires writing to WB.

| Mode | Pre-requisites                            | Proves                                                | When to use                                  |
|------|-------------------------------------------|-------------------------------------------------------|----------------------------------------------|
| A    | `WB_API_TOKEN` set to a production token  | Valid-token PASS + invalid-token FAIL on production   | Default. Safest read-only validation.        |
| B    | `WB_API_TOKEN` set to a Test scope token  | Valid-token PASS + invalid-token FAIL on sandbox      | Owner cannot provide a production token.     |
| C    | `WB_API_TOKEN` unset / empty              | Invalid-token FAIL on production; valid-token mocked  | Pre-credential dry run; CI without secrets.  |

Mode C still produces a Pass 3 report with PASS for "invalid token rejected" and N/A (with mocked fixture evidence) for "valid token accepted". This is the safest dev approach when no real token is available.

## 3. Environment variables (env-only, no values committed)

Defined in `.env.example.sellernerve`:

```
WB_API_TOKEN=replace_me
```

Additional optional knobs used by the proof script (placeholders only):

```
WB_API_HOST=https://common-api.wildberries.ru     # override to a -sandbox host for Mode B
WB_TOKEN_MASK_TAIL=4                              # last N chars retained when masking
WB_PING_PATH=/ping
WB_SELLER_INFO_PATH=/api/v1/seller-info
```

Real values must be loaded via the shell environment (e.g. a local `.env` file ignored by git, or platform secret manager). They MUST NOT appear in code, logs, commits, comments, screenshots, or reports.

## 4. Exact commands

All commands below assume the env var is already loaded into the current shell (e.g. via `set -a; . .env.local; set +a`). The token value is referenced as `$WB_API_TOKEN` and never echoed. The mask helper produces a label like `wb_****abcd` for safe reporting.

### 4.1 Mask helper (paste into shell once)

```bash
mask() {
  local t="${1:-$WB_API_TOKEN}"
  local n="${WB_TOKEN_MASK_TAIL:-4}"
  if [[ -z "$t" ]]; then echo "wb_(unset)"; return; fi
  echo "wb_****${t: -$n}"
}
```

`mask` is the only sanctioned way to refer to the token in any output.

### 4.2 Negative case — no token (requires NO secret)

```bash
HOST="${WB_API_HOST:-https://common-api.wildberries.ru}"

curl -sS -o /tmp/wb_no_token.json -w 'HTTP %{http_code}\n' \
  --max-time 10 "$HOST/api/v1/seller-info"
jq -r '.title, .detail' /tmp/wb_no_token.json
```

Expected (PASS criterion): HTTP `401` and `detail == "empty Authorization header"`.

### 4.3 Negative case — bogus token (requires NO secret)

```bash
HOST="${WB_API_HOST:-https://common-api.wildberries.ru}"

curl -sS -o /tmp/wb_bad_token.json -w 'HTTP %{http_code}\n' \
  --max-time 10 -H 'Authorization: x.y.z' "$HOST/api/v1/seller-info"
jq -r '.title, .detail' /tmp/wb_bad_token.json
```

Expected (PASS criterion): HTTP `401` and `detail` starts with `"access token problem; token is malformed"`.

Note: The literal `x.y.z` is a deliberate non-secret. It is **not** a real token; treating it as such is impossible because each segment must base64-decode to JSON.

### 4.4 Positive case — valid token (requires `WB_API_TOKEN`)

```bash
HOST="${WB_API_HOST:-https://common-api.wildberries.ru}"

if [[ -z "$WB_API_TOKEN" ]]; then
  echo "SKIP: WB_API_TOKEN not set (Mode C)"; exit 0
fi

# /ping
curl -sS -o /tmp/wb_ping.json -w 'HTTP %{http_code}\n' \
  --max-time 10 \
  -H "Authorization: $WB_API_TOKEN" \
  "$HOST/ping"
echo "token=$(mask)"
jq -r '.Status' /tmp/wb_ping.json

# /seller-info (skip on Mode B because sandbox has no common-api)
if [[ "$HOST" == *"-sandbox.wildberries.ru" ]]; then
  echo "SKIP: /api/v1/seller-info not available on sandbox host"
else
  curl -sS -o /tmp/wb_seller.json -w 'HTTP %{http_code}\n' \
    --max-time 10 \
    -H "Authorization: $WB_API_TOKEN" \
    "$HOST/api/v1/seller-info"
  jq -r '"sid="+.sid+" tradeMark_len="+(.tradeMark|tostring|length|tostring)' /tmp/wb_seller.json
fi
```

Expected (PASS criteria):
- `/ping` → HTTP `200`, body `{"Status":"OK", "TS":"<RFC3339>"}`.
- `/api/v1/seller-info` (Mode A only) → HTTP `200`, body contains non-empty `sid` (UUID v4) and `name`.

The token value never enters stdout; only the masked label and HTTP/Status/sid are logged.

### 4.5 One-shot script

`scripts/wb_probe.sh` (to be added in the implementation pass — not committed yet) wraps the above into a single PASS/FAIL emitter. Skeleton:

```bash
#!/usr/bin/env bash
set -euo pipefail
HOST="${WB_API_HOST:-https://common-api.wildberries.ru}"
mask() { local t="${1:-$WB_API_TOKEN}" n="${WB_TOKEN_MASK_TAIL:-4}"; \
         [[ -z "$t" ]] && echo "wb_(unset)" || echo "wb_****${t: -$n}"; }

probe() { # $1=label $2=auth_header_value(""=omit)
  local label="$1" auth="$2" http body detail status
  if [[ -n "$auth" ]]; then
    http=$(curl -sS -o /tmp/wb.json -w '%{http_code}' --max-time 10 \
              -H "Authorization: $auth" "$HOST/api/v1/seller-info")
  else
    http=$(curl -sS -o /tmp/wb.json -w '%{http_code}' --max-time 10 \
              "$HOST/api/v1/seller-info")
  fi
  status=$(jq -r '.title // empty' /tmp/wb.json)
  detail=$(jq -r '.detail // empty' /tmp/wb.json)
  echo "[$label] http=$http title=$status detail=$detail"
}

echo "host=$HOST token=$(mask)"
probe "no_token"   ""
probe "bad_token"  "x.y.z"
if [[ -n "${WB_API_TOKEN:-}" ]]; then
  probe "valid_token" "$WB_API_TOKEN"
fi
```

Operators run `WB_API_HOST=... bash scripts/wb_probe.sh` and capture the output verbatim into the validation report.

## 5. Error classification table

WB returns 401 with a stable `detail` string. The classifier maps these into safe error classes; the raw `detail` may be logged because it never contains secret material.

| `detail` substring                                              | Class            | Action                                |
|-----------------------------------------------------------------|------------------|---------------------------------------|
| `empty Authorization header`                                    | `missing_token`  | Prompt seller to paste token          |
| `token is malformed`                                            | `malformed_token`| Reject; advise re-copy from cabinet   |
| `token is expired`                                              | `expired_token`  | Prompt seller to rotate (180-day TTL) |
| `signature is invalid` / `signing method`                       | `tampered_token` | Reject; escalate                      |
| `token category` / `access denied to the requested API`         | `wrong_scope`    | Ask seller to enable required category|
| anything else with `status:401`                                 | `unauthorized_other` | Log requestId; surface to support |
| `status:402` (`Payment required`)                               | `service_payment_required` | Only for `Solutions for business` tokens; surface to seller |
| `status:403`                                                    | `access_denied`  | Check token owner / Jam subscription  |
| `status:429`                                                    | `rate_limited`   | Honor `X-Ratelimit-Retry`             |
| `status:5xx`                                                    | `wb_outage`      | Retry; check <https://dev.wildberries.ru/en/wb-status> |

Only the class name + WB `requestId` should be persisted in any audit log.

## 6. PASS/FAIL evidence template (paste into the final validation report)

```text
WB token validation — Pass 3 evidence

Mode: <A | B | C>
Host: <https://common-api.wildberries.ru | https://content-api-sandbox.wildberries.ru | ...>
Token reference: <wb_****xxxx | wb_(unset)>
Date: <YYYY-MM-DD>

| Check                                              | Result   | HTTP | detail / class             |
|----------------------------------------------------|----------|------|----------------------------|
| Negative: no Authorization header                  | PASS/FAIL| 401  | empty Authorization header |
| Negative: malformed token `x.y.z`                  | PASS/FAIL| 401  | malformed_token            |
| Positive: /ping with valid token                   | PASS/FAIL/N-A| 200| Status=OK                  |
| Positive: /api/v1/seller-info with valid token     | PASS/FAIL/N-A| 200| sid=<UUID present>         |
| Token category mismatch (if tested)                | PASS/FAIL/N-A| 401| wrong_scope                |

requestIds (for WB support, never secrets):
- no_token:    <requestId>
- bad_token:   <requestId>
- valid_ping:  <requestId>
- valid_info:  <requestId>

Commands executed: see scripts/wb_probe.sh
Changed files: <list>

Secrets were not exposed.
```

A `PASS` for "valid token accepted" requires HTTP 200 on `/ping` AND HTTP 200 on `/api/v1/seller-info` (Mode A) with a non-empty `sid`. In Mode B, only the `/ping` row contributes to the positive PASS, and the seller-info row is recorded as N/A with the reason "no sandbox host for common-api".

## 7. Safe dev approach when no sandbox / no token is available (Mode C)

If neither a production token nor a Test scope token is available, the proof is still actionable:

1. **Read-only probe against production** with no Authorization header AND with the literal `x.y.z` bogus token. This yields deterministic 401 responses (verified in this session) that exercise the classifier end-to-end.
2. **Mocked fixtures** for the positive case using the documented response shapes:

   `tests/fixtures/wb_seller_info_ok.json` (shape from WB docs, no real seller):

   ```json
   {
     "name": "OOO Test Seller",
     "sid": "00000000-0000-4000-8000-000000000000",
     "tin": "0000000000",
     "tradeMark": "Test Brand"
   }
   ```

   `tests/fixtures/wb_ping_ok.json`:

   ```json
   { "TS": "2025-01-01T00:00:00+00:00", "Status": "OK" }
   ```

   Tests assert that the classifier returns `ok` for these fixtures and `malformed_token` for the live 401 from production.

3. **No production mutations.** Mode C never sends authenticated POST/PUT/DELETE/PATCH requests. The repository should not even contain client code that targets mutating WB endpoints until a later, scoped milestone.

This is the safest dev approach: it produces real evidence (live HTTP captures) without any secret, and proves the classifier is wired correctly when paired with the fixtures.

## 8. Secret-handling rules (recap)

- Tokens are loaded only from runtime env (`WB_API_TOKEN`).
- Tokens are referenced in logs only via `mask()`.
- Tokens are passed to `curl` via `-H "Authorization: $WB_API_TOKEN"`, never embedded in URLs.
- Tokens are not written to `/tmp/wb*.json` (responses contain only seller identity fields).
- `set -x` is forbidden during probe execution.
- Decoded JWT contents (sid, exp) may be logged. Raw JWT must not.
- WB sandbox data is randomly generated and is also not logged in full; only `sid` and HTTP/Status are surfaced.

## 9. Confirmation

Secrets were not exposed. No tokens, real `sid` values, or `.env` contents appear in this document. All `requestId` values are placeholders; the real ones come from the operator's own run.
