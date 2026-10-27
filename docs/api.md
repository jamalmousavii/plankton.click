# مستندات API — Plankton Network

نسخه بک‌اند: `1.0.0` — پایه: `https://plankton.click` (نمونه: `https://plankton.click/api/chat`)

همه پاسخ‌ها JSON هستند. در حالت موفقیت معمولاً `success: true` برمی‌گردد و در حالت خطا `error` (رشته) یا `details` (لیست خطاهای اعتبارسنجی).

---

## احراز هویت

دو نوع توکن وجود دارد:

| توکن | کاربرد |
|------|--------|
| JWT کاربر (`Authorization: Bearer <token>`) | پروفایل، کیف پول، چت، ورکرهای کاربر |
| `worker_token` (`pw_...`) | فقط برای ورکرها: heartbeat و ثبت دستگاه |

نکات:

- JWT فقط با الگوریتم `HS256` و `JWT_SECRET` سرور پذیرفته می‌شود (`alg: none` یا کلید دیگر → `401`).
- `role` در ثبت‌نام فقط `user` یا `worker` است؛ مقدار `admin` پذیرفته نمی‌شود (`400`).
- نقش ادمین در هر درخواستِ `admin` دوباره از دیتابیس خوانده می‌شود (کش ۶۰ ثانیه‌ای) و در صورت خطا `fail-closed` است.
- حساب مسدود (`users.banned`، v3.39.0) هم هنگام ورود و هم در هر درخواستِ احرازشده رد می‌شود: `403` با پیام `Account banned.` (کش وضعیت ۱۰ ثانیه‌ای؛ تغییر `ban`/`role` کش را باطل می‌کند).

### نرخ محدودیت (Rate limit)

| مسیر | سقف |
|------|-----|
| عمومی `/api/` | ۲۰۰ درخواست / ۱۵ دقیقه |
| `/api/auth/login` و `register` | ۱۰ / ۱۵ دقیقه |
| `/api/auth/forgot-password` و `reset-password` | ۱۰ / ۱۵ دقیقه |
| `/api/chat` (کاربر واردشده) | ۳۰ / دقیقه |
| `/api/chat` (مهمان، بدون توکن) | ۶ / دقیقه |
| `/api/tickets` | ۱۰ / ۵ دقیقه (v3.39.0) |
| nginx روی `/api/` | ۱۰ r/s با burst=40 (پاسخ `429`) |

---

## کاربران

### POST `/api/auth/register`

```json
{ "email": "user@example.com", "password": "password123" }
```

پاسخ: `{ "success": true, "token": "...", "user": { "id", "email", "name", "role" } }`

### POST `/api/auth/login`

```json
{ "email": "user@example.com", "password": "password123" }
```

### POST `/api/auth/google`

```json
{ "credential": "google-id-token" }
```

### POST `/api/auth/set-password`

تنظیم رمز برای حساب‌های Google-only (نیازمند JWT).

### POST `/api/auth/change-password`

```json
{ "currentPassword": "...", "newPassword": "..." }
```

### POST `/api/auth/forgot-password`

```json
{ "email": "user@example.com" }
```

- اگر `RESEND_API_KEY` تنظیم نشده باشد → **`503`** (بدون توجه به وجود حساب، تا امکان شمارش حساب‌ها نباشد).
- توکن ریست **هرگز** در پاسخ یا لاگ برنمی‌گردد؛ فقط با ایمیل ارسال می‌شود.
- پاسخ موفق: `{ "success": true, "message": "If an account exists, a reset link has been sent." }`
- لینک: `BACKEND_URL/reset-password?token=...` (اعتبار ۱ ساعته)

### POST `/api/auth/reset-password`

```json
{ "token": "...", "password": "newpassword" }
```

---

## چت

### POST `/api/chat`

نیازمند توکن نیست (مهمان هم می‌تواند) اما مهمان نرخ محدودیت سخت‌تری دارد.

```json
{ "message": "سلام", "model": "llama3.1:8b", "session_id": 12 }
```

پاسخ موفق:

```json
{
  "success": true,
  "response": "...",
  "task_id": 123,
  "session_id": 12,
  "tokens_used": 420,
  "cost": 0.00007,
  "coin": "USD",
  "payment_status": "free | free_worker | tokens | paid",
  "worker_id": 7,
  "source": "worker | local",
  "worker_credit_remaining": 0.99,
  "free_tokens_remaining": 1999580,
  "token_balance_remaining": 4200000,
  "notice": "upgrade_recommended",
  "plans": [ { "name": "plus", "label": "Plus", "price": 4.99, "daily_tokens": 10000000, "interval_days": 30, "value_usd_day": 1.58, "value_usd_month": 47.4 } ],
  "token_bundle": { "price_per_million": 1, "tokens_per_usd": 1000000, "min_usd": 1, "max_usd": 500 }
}
```

`notice` فقط روی پیام‌های `paid` می‌آید (فرانت‌اند بنر روزانهٔ ارتقا نشان می‌دهد) و همراهش `plans` + `token_bundle` می‌آید. فیلد `token_balance_remaining` فقط روی پایهٔ توکن (`payment_status: "tokens"`) می‌آید.

**پیش‌بررسی پوشش (v3.28.0):** قبل از dispatch بررسی می‌شود: سقف رایگان روزانه > 0 یا اعتبار ورکر > 0 یا موجودی کیف توکن > 0 یا کیف پول > 0؟ اگر **هیچ پوششی** نباشد → `402 { code: "upgrade_required", free, plans, token_bundle, signed_in }` (دیوار ارتقای سه‌سطحی + پیشنهاد بسته توکن؛ برای مهمان با پیام ثبت‌نام). خطای خودِ این بررسی هرگز چت را بلاک نمی‌کند.

**زنجیره پرداخت (یک تراکنش با قفل ردیف):**

1. **سقف رایگان روزانه (v3.27.0)**: ۲,۰۰۰,۰۰۰ توکن به ازای هر UTC-day — کاربران عضو در `daily_tokens`، مهمان‌ها با IP در `daily_tokens_guest`؛ پلن‌های پولی سقف را بالا می‌برند (تا ۸۰,۰۰۰,۰۰۰ روی مکس) → `payment_status: "free"` (منبع پلتفرم، **بدون سهم ورکر**).
2. **اعتبار رایگان ورکر (v3.25.0)**: ورکر `online`/`busy` → سقف **$۱ هر روز UTC** → `"free_worker"` (نه از کیف پول، نه سهم ورکر).
3. **کیف توکن (بستهٔ پیش‌پرداخت، v3.28.0)**: `chargeTokenPot` تمام‌یا-هیچ کم می‌کند (race-safe) → `"tokens"` + `token_balance_remaining`؛ ورکر **۹۰٪** ارزش کاتالوگ پیام را می‌گیرد (از درآمد بسته‌ها) با `source = 'tokens'`.
4. **کیف پول USD**: سهم ورکر **۹۰٪ ثابت** صرف‌نظر از پلن خریدار (فقط اگر واقعاً ورکر جواب داده باشد)، با `source = 'wallet'` و `plan_type` خریدار. اگر موجودی از `cost` کمتر باشد **به‌طور کامل** کم می‌شود تا کیف پول به صفر برسد و دیوار در پیام بعدی نمایان شود → `"paid"` + `notice: "upgrade_recommended"`.
5. مسابقه بعد از pre-flight (سقف همزمان تمام شده) → پاسخِ تولیدشده سرو می‌شود با `"free"` — تولیدِ انجام‌شده هرگز تلف نمی‌شود.
6. مهمان بدون پوشش → از همان pre-flight دیوار می‌بیند.

قیمت‌گذاری: `cost = tokens × outputPrice / 1e6` (قیمت مدل انتخاب‌شده از `src/models.js`).

### پیوست (v3.20.0)

یک فیلد اختیاری `attachment` به بدنهٔ بالا اضافه کنید (حداکثر یک پیوست در هر پیام):

```json
{
  "message": "این فایل رو خلاصه کن",
  "model": "llama3.1:8b",
  "attachment": { "type": "file", "name": "doc.pdf", "mime": "application/pdf", "data": "<base64 خام>" }
}
```

| type | رفتار | مدل موردنیاز |
|------|-------|----------------|
| `image` | به‌صورت `images[]` به Ollama می‌رود (کلاینت تا ≤1280px فشرده می‌کند) | `vision: true` (`qwen3-vl:8b`, `gemma4:12b`) |
| `file` | PDF/متن سمت سرور استخراج و به ابتدای prompt می‌چسبد؛ مدل‌های متنی هم جواب می‌دهند | هر مدل چت |
| `audio` | WAV 16kHz mono (کلاینت می‌سازد، حداکثر ۶۰ ثانیه) — همان شکاف `images[]` | `audio: true` (`gemma4:12b`) |

محدودیت‌ها: `data` حداکثر ~۴MB base64 (تصویر ≤~1.5MB، فایل ≤1.5MB خام، PDF متن ≤60k کاراکتر).

خطاهای صریح (پیوست هرگز بی‌صدا حذف نمی‌شود):

| کد HTTP | `code` | معنی |
|---------|--------|------|
| 400 | `ATTACHMENT_UNSUPPORTED` | نوع فایل/مدل نامناسب (مثلاً تصویر با مدل بدون vision) |
| 400 | `ATTACHMENT_TOO_LARGE` / `ATTACHMENT_INVALID` / `ATTACHMENT_EMPTY` / `ATTACHMENT_PARSE_FAILED` / `AUDIO_FORMAT` | سایز/فرمت/استخراج ناموفق |
| 409 | `MEDIA_NO_WORKER` | ورکرِ سازگار (نسخه ≥ 3.20.0) برای رسانه آنلاین نیست (fallback محلی در v3.40.0 حذف شد) |
| 409 | `MODEL_UNAVAILABLE` | ورکر آنلاین هست ولی مدل درخواستی را ندارد — `requested_model` + تا ۶ `alternatives` (اول هم‌دسته، بعد پرورکرترین)؛ بدون شارژ |
| 503 | `WORKER_OFFLINE` | هیچ ورکری آنلاین نیست — `retryable: true`؛ بدون شارژ (کلاینت auto-retry می‌کند) |

تاریخچه: پیام‌های کاربر در `GET /api/chat/sessions/:id` فیلد `media` (JSONB از `tasks.media`) دارند.

### مدیریت جلسات

| متد و مسیر | توضیح |
|-----------|-------|
| `GET /api/chat/sessions` | لیست جلسات کاربر |
| `POST /api/chat/sessions` | ساخت جلسه (`subject`, `model`) — `subject` حداکثر ۲۵۵ کاراکتر |
| `GET /api/chat/sessions/:id` | یک جلسه + پیام‌ها |
| `PUT /api/chat/sessions/:id` | تغییر عنوان |
| `DELETE /api/chat/sessions/:id` | حذف جلسه |
| `GET /api/chat/history` | ۵۰ درخواست آخر کاربر (legacy) |

---

## ورکرها

### `GET /api/workers` (عمومی)

لیست ورکرهای آنلاین برای نمایش عمومی — **بدون** `wallet_address` و `worker_token`، حداکثر ۱۰۰ ردیف.

### `GET /api/workers/:id` (فقط مالک)

### `POST /api/workers` (نیازمند JWT)

ساخت ورکر جدید: `{ "name": "worker1" }` → پاسخ شامل `worker_token` (فقط یک بار نمایش داده می‌شود).

### `GET /api/workers/mine`

ورکرهای خودِ کاربر (به‌جز `removed`)؛ `worker_token` بعد از اولین اتصال `null` می‌شود.
از `v3.22.0` ورکرهایی که بیش از **۱۰ روز** است تماس نگرفته‌اند هم از این لیست حذف و به History می‌روند (با اتصال دوباره خودبه‌خود برمی‌گردند).

### `GET /api/workers/history` (نیازمند JWT)

تاریخچه ورکرها: ورکرهای `removed` + ورکرهای بیش از ۱۰ روز آفلاین.

- هر ردیف: `id`, `name`, `gpu_model`, `total_tasks`, `earnings`, `created_at`, `last_seen`, `uninstalled_at`, `reason` (`uninstalled` | `offline>10d`)
- `summary`: `total_added`, `total_tasks`, `total_earnings` (روی همه ورکرهای کاربر)

### متدهای مدیریت (نیازمند JWT و مالکیت)

| متد و مسیر | توضیح |
|-----------|-------|
| `PUT /api/workers/mine/model` | تغییر مدل (`model`, `worker_id` اختیاری) |
| `PUT /api/workers/mine/:id` | تغییر نام |
| `PUT /api/workers/mine/:id/token` | ساخت توکن جدید (نصب مجدد) |
| `DELETE /api/workers/mine/:id` | حذف نرم — `uninstalled_at` ثبت، تاریخچه در History محفوظ می‌ماند |
| `GET /api/workers/mine/:id/earnings` | درآمد طول‌عمر یک ورکر + تفکیک ۵‌طرفه (شامل `removed`ها؛ فقط مالک؛ ناموجود/غیرمالک → `404`) |

### `POST /api/token` (نیازمند JWT)

دریافت/ساخت توکن سطح حساب (legacy).

### `POST /api/workers/setup` (عمومی، با توکن)

```json
{ "email": "a@b.co", "worker_token": "pw_...", "gpu_model": "...", "ram": "32 GB", "cpu": "...", "models": ["llama3.1:8b"], "machine_id": "...", "name": "vps1" }
```

- توکنِ ورکرِ اختصاصی → بلافاصله ثبت/به‌روزرسانی.
- توکنِ سطح حساب → فقط وقتی کاربر دقیقاً یک ورکر فعال دارد؛ در غیر این صورت `409`.
- ورکرِ `removed` دوباره زنده نمی‌شود → `401`.

### `POST /api/workers/unregister` (عمومی، با توکن)

```json
{ "worker_token": "pw_..." }
```

از `v3.22.0` — توسط اسکریپت‌های `uninstall-*.sh` قبل از حذف فایل‌ها صدا زده می‌شود: ورکر `removed` + `uninstalled_at` ثبت و اتصال WS آن بسته می‌شود. **Idempotent**: توکل نامعتبر/تکراری هم `200 { success: true, unregistered: false }` برمی‌گرداند تا uninstall هرگز به‌خاطر سرور شکست نخورد.

### `PUT /api/workers/:id/heartbeat`

بدون JWT؛ با `worker_token` در body. `status` فقط `online|offline|busy` پذیرفته می‌شود، `tasks_completed` بین ۰ تا ۱۰۰۰ محدود است و ورکرِ `removed` به‌روز نمی‌شود.

### `POST /api/workers/register`

غیرفعال است (`403`) — از `/api/workers/setup` استفاده شود.

---

## پرداخت

### `GET /api/payments/coins`

لیست کوین‌های قابل واریز (NowPayments).

### `POST /api/payments/deposit/create`

```json
{ "amount_usd": 25, "coin": "USDT" }
```

پاسخ شامل `invoice_url` (صفحه پرداخت NowPayments) و `order_id` است. این `order_id` در `coin_deposits` ذخیره می‌شود.

### `POST /api/payments/deposit/webhook` (عمومی، امضای IPN)

- اعتبارسنجی HMAC-SHA512 با `NOWPAYMENTS_IPN_SECRET` (**fail-closed**: بدون تنظیم بودنِ secret هیچ وب‌هوکی پذیرفته نمی‌شود).
- ادعا (claim) ایدمپوتنت با `order_id`/`processor_id` در یک تراکنش: وب‌هوکِ تکراری اعتباری اضافه نمی‌کند.
- مبلغ از **ردیف دیتابیس** خوانده می‌شود، نه از payload.
- `order_id` با پیشوند `plus-`/`pro-`/`max-` → اشتراک همان پلن: ادعای `plan_purchases` (`pending` → `completed`، دقیقاً یک‌بار) و سپس فعال‌سازی ۳۰ روزه (`expires_at = max(expires, now) + 30d`)؛ با پیشوند `tok-` → شارژ بستهٔ توکن (`creditTokens`)؛ **هرگز** موجودی کیف پول را تغییر نمی‌دهند. واریزهای معمولی (`plankton-…`) فقط موجودی را شارژ می‌کنند.

### `GET /api/payments/balance` (نیازمند JWT)

```json
{ "success": true, "balances": { "USD": { "available": 12.5, "total_earned": 30, "total_spent": 17.5 } }, "worker_credit": { "eligible": true, "limit": 1, "used": 0.01, "remaining": 0.99 }, "free_tokens": { "limit": 2000000, "used": 420, "remaining": 1999580 }, "plan": { "name": "plus", "active": true, "expires_at": "2026-11-02T00:00:00.000Z" }, "plans": [ ... ], "token_bundle": { "price_per_million": 1, "tokens_per_usd": 1000000, "min_usd": 1, "max_usd": 500, "balance": 5000000 } }
```

### `POST /api/payments/withdraw`

```json
{ "amount": 5, "address": "T..." }
```

برداشت با یک `UPDATE ... WHERE available >= amount` اتمیک انجام می‌شود (حداقل ۵ دلار).

### `GET /api/payments/history`

`limit` بین ۱ تا ۱۰۰.

### `POST /api/payments/deduct` (نیازمند JWT)

کم‌کردن موجودی خودِ کاربر (اتمیک).

---

## طرح‌ها و بستهٔ توکن (v3.28.0)

### `GET /api/plans` (عمومی — با توکن، بلوک سهمیه هم می‌آید)

```json
{ "success": true,
  "plans": [
    { "name": "plus", "label": "Plus", "price": 4.99, "daily_tokens": 10000000, "interval_days": 30, "value_usd_day": 1.58, "value_usd_month": 47.4 },
    { "name": "pro",  "label": "Pro",  "price": 9.99, "daily_tokens": 30000000, "interval_days": 30, "value_usd_day": 4.74, "value_usd_month": 142.2 },
    { "name": "max",  "label": "Max",  "price": 19.99, "daily_tokens": 80000000, "interval_days": 30, "value_usd_day": 12.64, "value_usd_month": 379.2 }
  ],
  "plan": { "name": "free", "active": false, "expires_at": null },
  "daily_limit": 2000000,
  "token_bundle": { "price_per_million": 1, "tokens_per_usd": 1000000, "min_usd": 1, "max_usd": 500 },
  "free_tokens": { "limit": 2000000, "used": 420, "remaining": 1999580 },
  "token_balance": 0 }
```

### `POST /api/plans/:tier/purchase` (نیازمند JWT)

`:tier` یکی از `plus|pro|max` (وگرنه `400 INVALID_PLAN`) → بدون body → فاکتور NowPayments به مبلغ همان پلن (crypto-only) + ردیف `plan_purchases` با `plan_type` و وضعیت `pending`:

```json
{ "success": true, "invoice": { "id": 555, "url": "https://nowpayments.io/payment/?iid=...", "order_id": "pro-12-1759480000000", "amountUsd": 9.99, "plan": "pro" } }
```

پرداخت موفق → IPN همان مسیر وب‌هوک قبلی، اما با پیشوند `plus-`/`pro-`/`max-` → فعال‌سازی/تمدید با `activatePlan`: از `max(now, expiry)` + ۳۰ روز. چند پلن همزمان مجاز است؛ سقف بزرگ‌ترین پلن فعال اعمال می‌شود.

### `POST /api/plans/tokens/purchase` (نیازمند JWT)

بدنه: `{ "amount_usd": 5 }` — عدد صحیح بین **$۱ و $۵۰۰** (≥ حداقل واریز NowPayments) → **۵,۰۰۰,۰۰۰ توکن** (هر دلار ۱M، **بدون انقضا**):

```json
{ "success": true, "invoice": { "id": 556, "url": "https://nowpayments.io/payment/?iid=...", "order_id": "tok-12-1759480000000", "amountUsd": 5, "tokens": 5000000 } }
```

IPN با پیشوند `tok-` → ادعای exactly-once `plan_purchases` → `creditTokens()` (جمع‌شونده روی `user_token_balances`).

---

## توکن (legacy)

### `GET /api/token/balance` (نیازمند JWT)

```json
{ "success": true, "available": 5.0, "total_earned": 2.0, "total_spent": 0.5, "worker_credit": { "eligible": true, "limit": 1, "used": 0.01, "remaining": 0.99 }, "free_tokens": { "limit": 2000000, "used": 420, "remaining": 1999580 }, "plan": { "name": "free", "active": false, "expires_at": null }, "plans": [ ... ], "token_bundle": { "price_per_million": 1, "tokens_per_usd": 1000000, "min_usd": 1, "max_usd": 500, "balance": 5000000 } }
```

### `POST /api/token/deposit|deduct|transfer`

**غیرفعال شده → `410 Gone`.** موجودی فقط از مسیر پرداخت و چت تغییر می‌کند.

---

## Coder API برای ایجنت‌ها (v3.43.0 — سازگار OpenAI)

احراز: `Authorization: Bearer sk_...` (کلید از Settings؛ فقط هش نگه داشته می‌شود).
فقط دو مدل coder. مهمان ندارد. ریت‌لیمیت جدا: ۱۲۰ در دقیقه.

| مسیر | توضیح |
|------|-------|
| `GET /v1/models` | لیست OpenAI (`{object:'list', data:[{id, object:'model'}]}`) |
| `POST /v1/chat/completions` | ورودی `{model, messages[], max_tokens?, temperature?}`؛ خروجی استاندارد + `usage {prompt_tokens(تخمینی), completion_tokens, total_tokens}` |

گیت مالکیت: pot/wallet/plan پولی لازم است — کاربر free خالی → `402 {code:"api_payment_required", plans, token_bundle}`. سقف = مالکیت (موجودی pot / سقف روزانه tier / موجودی wallet). billing همان زنجیره چت (فقط خروجی).

نمونه:

```bash
curl https://plankton.click/v1/chat/completions \
  -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
  -d '{"model":"qwen3-coder:30b","messages":[{"role":"user","content":"write fizzbuzz in python"}]}'
```

اتصال opencode (`opencode.json` + `export PLANKTON_API_KEY=sk_...`): provider `plankton` با `npm: @ai-sdk/openai-compatible` و `baseURL: https://plankton.click/v1`؛ مدل‌ها `qwen3-coder:30b` (context 262144/output 32768) و `qwen2.5-coder:32b` (32768/8192).

محدودیت فاز ۱: `stream:true` → `400 stream_not_supported`؛ `tools` → `400 tool_not_supported`.

---

## کلیدهای API (v3.43.0 — نیازمند JWT؛ ساخت از Settings)

فقط برای Coder API (`/v1`). مقدار کلید `sk_...` تنها یک‌بار (در پاسخ ساخت) نمایش داده می‌شود؛ سرور فقط هش sha256 را نگه می‌دارد. حداکثر ۱۰ کلید فعالِ هم‌زمان.

| متد و مسیر | توضیح |
|------|-------|
| `GET /api/keys` | لیست کلیدها (نام، prefix، `last_used_at` — بدون هش) |
| `POST /api/keys` | ساخت کلید: بدنه `{name}` → مقدار کامل فقط در همین پاسخ |
| `DELETE /api/keys/:id` | ابطال کلید (فقط مالک) |

---

## سازمان‌ها (v3.44.0 — نیازمند JWT؛ ساخت سازمان فقط توسط ادمین)

سازمان = یک سطل مشترک از سقف پلنِ لیدر. کاربرها خودشان ثبت‌نام می‌کنند و لیدر با ایمیل اضافه‌شان می‌کند. سقف مؤثر هر عضو = `max(سقف خودِ عضو, سقف لیدر)`؛ پات توکن، کیف پول و اعتبار ورکر هر عضو جداست. یک عضویت فعال برای هر کاربر (v3.45.0: با ایندکس unique در دیتابیس تضمین می‌شود).

| متد و مسیر | توضیح |
|------|-------|
| `GET /api/orgs/mine` | سازمان + اعضای فعال + snapshot سطل مشترک |
| `GET /api/orgs/usage` | مصرف ۳۰ روز: لیدر همه را می‌بیند، عضو فقط ردیف خودش |
| `POST /api/orgs/members` | بدنه `{email}` — افزودن کاربر ثبت‌نام‌شده (فقط لیدر). ایمیل ناشناس → `404`؛ عضو فعالِ سازمان دیگر → `400`. v3.45.0: سقف ۲۰ افزودن در ۱۵ دقیقه برای هر لیدر؛ کل عملیات در یک تراکنش |
| `DELETE /api/orgs/members/:userId` | حذف عضو (فقط لیدر؛ خودش → `400`؛ عضو ناموجود → `404`) |
| `POST /api/orgs/transfer` | بدنه `{user_id}` — انتقال لیدری به عضو فعال (تراکنش + قفل ردیف سازمان) |
| `POST /api/orgs/leave` | خروج از سازمان؛ لیدرِ رفته → قدیمی‌ترین عضو لیدر می‌شود؛ خروج آخرین عضو → `disbanded` |

ادمین (با audit، جزئیات در بخش ادمین): `GET/POST /api/admin/orgs`، `POST /api/admin/orgs/:id/members`، `DELETE /api/admin/orgs/:id/members/:userId`، `POST /api/admin/orgs/:id/disband`.

---

## مدل‌ها، رتبه‌بندی

| مسیر | توضیح |
|------|-------|
| `GET /api/models` | کاتالوگ مدل‌ها + تعداد ورکر آنلاین هر مدل (`unknown_models` برای مدل‌های خارج از کاتالوگ) — کش ۱۵ ثانیه |
| `GET /api/models/categories` | دسته‌بندی‌ها |
| `GET /api/leaderboard/workers` | ۵۰ ورکر برتر |
| `GET /api/leaderboard/users` | ۵۰ کاربر برتر |
| `GET /api/leaderboard/mine` | رتبه خودِ کاربر بین ورکرها (نیازمند JWT؛ `RANK()` روی درآمد + `breakdown: {tokens, wallet, plus, pro, max}` از `worker_coin_earnings`، v3.28.0) |

---

## تیکت‌های پشتیبانی (v3.39.0 — نیازمند JWT؛ فقط تیکتِ خودِ کاربر)

وضعیت‌ها: `open` (در انتظار پاسخ) → `answered` (پاسخ ادمین) → با پاسخ کاربر دوباره `open` → `closed` (هر دو طرف؛ پاسخ به تیکت بسته → `409`). دسته‌ها: `support` | `billing` | `worker`.

| متد و مسیر | توضیح |
|------|-------|
| `POST /api/tickets` | ساخت تیکت (`subject` ≤۲۰۰، `body` ≤۴۰۰۰، `category`) — تیکت و اولین پیام در یک تراکنش |
| `GET /api/tickets` | لیست تیکت‌های خودِ کاربر + پیش‌نمایش آخرین پیام (حداکثر ۵۰) |
| `GET /api/tickets/:id` | جزئیات + رشته پیام‌ها — مالکیت الزامی (دیگری → `403`) |
| `POST /api/tickets/:id/messages` | پاسخ کاربر → وضعیت `open`؛ تیکت بسته → `409` |
| `POST /api/tickets/:id/close` | بستن تیکت توسط خودِ کاربر |

---

## ادمین (نیازمند JWT + نقش `admin` در دیتابیس)

هر تغییرِ مدیریتی در همان تراکنش، ردیفی در `admin_audit_log` (کاربر/اکشن/هدف/دلیل/`payload JSONB`) می‌نویسد.

### مشاهده

| مسیر | توضیح |
|------|-------|
| `GET /api/admin/dashboard` | شمارنده‌ها + درآمد پلتفرم + تیکت‌های کل/باز |
| `GET /api/admin/users` | ۱۰۰ کاربر اخیر + موجودی دلار/توکن + پلن فعال + `banned` |
| `GET /api/admin/workers` | ۱۰۰ ورکر + ایمیل کاربر |
| `GET /api/admin/tasks` | ۱۰۰ تسک اخیر + ایمیل کاربر |
| `GET /api/admin/tickets?status=&q=` | لیست تیکت‌ها با ایمیل کاربر (فیلتر وضعیت + جستجو در موضوع/ایمیل) |
| `GET /api/admin/tickets/:id` | تیکت + ایمیل مالک + رشته پیام‌ها |
| `GET /api/admin/payments` | ۱۰۰ واریز + ۱۰۰ برداشت اخیر + ایمیل کاربر |
| `GET /api/admin/purchases` | ۱۰۰ خرید پلن/بسته اخیر + ایمیل کاربر |
| `GET /api/admin/orgs` | سازمان‌ها + اعضا + ایمیل لیدر (v3.44.0) |

### تغییرات (همگی `PUT`/`POST` با `body` JSON)

| متد و مسیر | توضیح |
|------|-------|
| `POST /api/admin/tickets/:id/messages` | پاسخ ادمین → وضعیت `answered`؛ تیکت بسته → `409` |
| `POST /api/admin/tickets/:id/status` | `{status: "open"\|"closed"}` — بازگشایی/بستن (ثبت در audit) |
| `PUT /api/admin/users/:id/role` | `{role: "user"\|"worker"\|"admin"}` — تغییر نقش خود → `409` |
| `PUT /api/admin/users/:id/ban` | `{banned: true\|false}` — مسدودی خود → `409`؛ کش نشست‌ها باطل می‌شود |
| `POST /api/admin/users/:id/balance` | `{delta_usd, reason}` — دلار ± (سقف ±۱M، `reason` ≥۳ حرف، موجودی منفی → `400`) |
| `POST /api/admin/users/:id/tokens` | `{delta_tokens, reason}` — توکن پات ± (عدد صحیح، کف صفر) |
| `PUT /api/admin/users/:id/plan` | `{plan: "plus"\|"pro"\|"max"}` — فعال‌سازی/تمدید ۳۰ روزه از `plans.activatePlan` |
| `PUT /api/admin/workers/:id/status` | `{status: "removed"\|"offline"}` — حذف/بازگردانی ورکر |
| `POST /api/admin/orgs` | `{name, leader_email}` — ساخت سازمان + ردیف لیدر (v3.44.0، تراکنش + audit) |
| `POST /api/admin/orgs/:id/members` | `{email}` — افزودن کاربر ثبت‌نام‌شده (v3.44.0) |
| `DELETE /api/admin/orgs/:id/members/:userId` | حذف عضو (لیدر حذف نمی‌شود؛ v3.44.0) |
| `POST /api/admin/orgs/:id/disband` | بستن سازمان؛ اعضا به پلن خودشان برمی‌گردند (v3.44.0) |

---

## سلامت

| مسیر | رفتار |
|------|-------|
| `GET /health` | readiness: بدون Postgres → `503` + `status: "degraded"`؛ Redis فقط گزارشی است؛ `chatUsable = online_workers > 0` (فیلد `ollama` در v3.40.0 حذف شد) |
| `GET /health/live` | liveness: همیشه `200` |

---

## WebSocket

آدرس: `wss://plankton.click/ws` (از داخل سرور: `ws://127.0.0.1:8444/ws`)

- احراز هویت ورکر با `worker_token`.
- پیام‌های کلیدی: `register`, `task_dispatch`, `task_result`, `heartbeat`.
- نتیجه تکراری (`task_result` برای تسکی که دیگر `pending/processing` نیست) نادیده گرفته می‌شود.

---

## کدهای خطا

| کد | معنا |
|----|------|
| `400` | اعتبارسنجی ناموفق (`details` شامل فیلدهاست) |
| `401` | توکن نامعتبر/نبودن توکن/توکنِ ورکر نامعتبر |
| `402` | **دیوار ارتقا (v3.28.0)**: هیچ پوششی برای پیام بعدی — `code: "upgrade_required"` + `free`/`plans`/`token_bundle`/`signed_in` (سقف رایگان تمام‌شده + بدون اعتبار ورکر + کیف توکن خالی + کیف پول خالی) |
| `402` | **گیت Coder API (v3.43.0)**: `code: "api_payment_required"` + `plans`/`token_bundle` (فقط `/v1`؛ plan رایگان خالی) |
| `403` | دسترسی ادمین لازم است / CORS |
| `404` | پیدا نشد |
| `409` | تعارض (چند ورکر با توکن سطح حساب) |
| `410` | endpoint قدیمی حذف شده |
| `429` | نرخ محدودیت |
| `500` | خطای داخلی |
| `503** | سرویس در دسترس نیست (بدون provider / بدون ایمیل / بدون Postgres) |
