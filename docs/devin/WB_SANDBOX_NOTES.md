# Wildberries Sandbox / Test Environment Notes

Scope: SellerNerve Pass 3 (WB token validation proof). WB-first only.
No Ozon. No broad marketplace abstraction. Secrets are loaded from env only and never echoed.

## TL;DR

- WB has an official **sandbox** (`*-sandbox.wildberries.ru`) advertised at <https://dev.wildberries.ru/en/sandbox>.
- The sandbox is **per-surface**, not a single host. It only exists for some API categories. Notably, the host that exposes seller identity (`common-api.wildberries.ru`) has **no sandbox twin**.
- Sandbox access requires a **Test token** (token type `t=true`, `acc=2`). Test tokens only work against `*-sandbox.wildberries.ru` and never touch real seller data.
- Production has a **read-only, non-mutating** "connection check" surface (`GET /ping`) on every host, plus a read-only seller identity endpoint (`GET /api/v1/seller-info` on `common-api`). These are the safest WB-first validation endpoints when an owner-provided production token must be used.
- Negative cases (no token, malformed token) can be probed **without any secret** on either production or sandbox; both return structured `401` JSON with stable `detail` strings.

## Authoritative sources

- WB API docs: <https://dev.wildberries.ru/en/docs/openapi/api-information>
- Sandbox page: <https://dev.wildberries.ru/en/sandbox>
- API status: <https://dev.wildberries.ru/en/wb-status>
- Token format: JWT, RFC 7519, 180-day validity, header `Authorization: <jwt>`.

## Token types (WB official)

Determined by `payload` fields of the JWT (`acc`, `for`, `t`).

| Type     | `acc` | `for`              | `t`     | Where it works                  | Risk for SellerNerve |
|----------|-------|--------------------|---------|---------------------------------|----------------------|
| Personal | `3`   | `self`             | `false` | Production hosts                | Highest privilege; on-prem only per WB rules |
| Service  | `4`   | `asid:{ServiceID}` | `false` | Production hosts                | Bound to a single registered cloud service |
| Base     | `1`   | (absent)           | `false` | Production hosts                | Limited capabilities; recommended for SellerNerve validation |
| Test     | `2`   | (absent)           | `true`  | **Sandbox hosts only**          | Cannot leak real seller data |

Token bitmask `s` controls per-category access (Content=bit 1, Analytics=bit 2, …, ReadOnly=bit 30). For SellerNerve's validation probe, a Read-Only token in any category is sufficient because both `/ping` and `/api/v1/seller-info` work with a token of any category.

## Sandbox surface coverage (from <https://dev.wildberries.ru/en/sandbox>)

| Category                                      | Sandbox host                                          | Notes |
|-----------------------------------------------|-------------------------------------------------------|-------|
| Content (cards, media, tags, subjects)        | `https://content-api-sandbox.wildberries.ru`          | 1 rps total; no `locale` param; product cards created instantly |
| Prices and Discounts, Promotions Calendar     | `https://discounts-prices-api-sandbox.wildberries.ru` | 1 rps total; depends on cards created in content sandbox |
| Marketplace (FBS/DBS/In-Store Pickup orders)  | `https://marketplace-api-sandbox.wildberries.ru`      | 1 rps per method; cross-border stickers/status_history return empty 200 |
| FBW Supplies                                  | `https://supplies-api-sandbox.wildberries.ru`         | 1 rps per method; barcodes from content sandbox |
| Promotion (advert campaigns)                  | `https://advert-api-sandbox.wildberries.ru`           | Test balance top-up available; campaign stats limited to 30 days |
| Feedbacks and Questions                       | `https://feedbacks-api-sandbox.wildberries.ru`        | Test feedback/question creation; auto-delete after 5 days idle |
| Statistics, Financial Reports                 | `https://statistics-api-sandbox.wildberries.ru`       | `dateFrom`/`dateTo` limited to last 4 months |

WB ping table (from the Authorization docs) also confirms sandbox `/ping` exists for: content, discounts-prices, marketplace (production-only per the dev portal table, but the host resolves and responds 401 to anonymous probes), statistics, advert, feedbacks.

## What is NOT in the sandbox

The following categories have **no `*-sandbox` host**. Validation against them is production-only:

- `common-api.wildberries.ru` — Tariffs, News, **Seller Information**, Jam subscriptions. *(DNS confirmed: `common-api-sandbox.wildberries.ru` does not resolve.)*
- `seller-analytics-api.wildberries.ru` — Analytics and Data
- `user-management-api.wildberries.ru` — Seller User Management
- `buyer-chat-api.wildberries.ru` — Buyers Chat
- `returns-api.wildberries.ru` — Buyers Returns
- `documents-api.wildberries.ru` — Documents
- `finance-api.wildberries.ru` — Balance and Financial Reports (note: read-only Statistics financial reports do have a sandbox)

Implication: the canonical "is this a real seller's token?" probe (`/api/v1/seller-info`) **cannot** be tested in sandbox. If an owner refuses to issue a production token, the closest sandbox equivalent for SellerNerve's narrow needs is `GET /ping` on a sandbox host using a Test scope token — this proves the token is syntactically valid and recognized by WB, but does not return identity fields.

## Sandbox properties relevant to SellerNerve

- "The data in the test scope is randomly generated and does not belong to real sellers. Using the test environment does not carry the risk of unintentional disclosure of information." — WB sandbox page.
- Hard rate limit: typically 1 request per second per method (or in total). The `/ping` endpoint everywhere is limited to "3 requests every 30 seconds; if you try to use this method programmatically the method will be temporarily blocked. The rate limit applies individually to each instance of the method on each host." — WB Authorization docs.
- Sandbox responses use the same JSON error envelope as production: `{title, detail, code, requestId, origin, status, statusText, timestamp}`. We verified this directly (see below).

## Direct probe evidence (executed from this session, no real token)

Production `common-api.wildberries.ru`:

```
GET /api/v1/seller-info                              -> HTTP 401
  detail: "empty Authorization header"

GET /api/v1/seller-info  Authorization: not-a-real-token  -> HTTP 401
  detail: "access token problem; token is malformed: token contains an invalid number of segments"

GET /api/v1/seller-info  Authorization: x.y.z              -> HTTP 401
  detail: "access token problem; token is malformed: could not base64 decode header: illegal base64 data at input byte 0"
```

Sandbox `content-api-sandbox.wildberries.ru` (same shape):

```
GET /ping                                             -> HTTP 401
  detail: "empty Authorization header"

GET /ping  Authorization: x.y.z                       -> HTTP 401
  detail: "access token problem; token is malformed: could not base64 decode header: illegal base64 data at input byte 0"
```

This identical error envelope is what makes a deterministic "invalid token" negative test possible **without any secret**.

## Decision for SellerNerve Pass 3

**First surface = `common-api.wildberries.ru`.** Specifically:

1. `GET https://common-api.wildberries.ru/ping` — cheapest reachability + auth check; works with any-category token.
2. `GET https://common-api.wildberries.ru/api/v1/seller-info` — identity-proving check; returns `{name, sid, tin, tradeMark}` on 200. Read-only.

Rationale:
- WB-first and category-agnostic (any read-only token validates here).
- Read-only; no mutation of seller data; no orders, no prices, no cards touched.
- Returns enough identity data to prove "this token belongs to seller `sid`" without needing to enumerate product surfaces.
- Aligns with the WB doc note: *"You can get seller information with a token of any category."*

Sandbox is documented but does **not** cover this surface. Sandbox is therefore the fallback for code paths that require live writes (e.g., later passes that hit marketplace orders). For Pass 3 it is used only for shape/contract verification.

## Risks and constraints

- **No common-api sandbox.** Token-belongs-to-seller verification has to happen against the production host. We mitigate by: GET-only; read-only category; explicit rate limit budget (≤ 3 calls / 30 s per host); never log raw token.
- **Test tokens are scoped to sandbox.** If only a Test token is provided, we cannot prove production reachability — only sandbox reachability. We document both paths.
- **/ping rate-limit is per-host per-method.** Operators should not loop /ping calls; one call per validation event is enough.
- **WB antibot on the dev portal** (HTTP 498 from non-browser clients) blocks programmatic doc fetching but does **not** affect the API hosts themselves.

## Confirmation

Secrets were not exposed. No tokens, .env contents, or seller identifiers appear in this document or in any commands above.
