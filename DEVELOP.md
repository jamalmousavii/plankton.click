# Plankton — Development Guide

Version **1.0.0**. A *worker* is any machine (and its owner) that joins the
Plankton network and takes part in answering user chats.

## Prerequisites

- Node.js 20+
- npm
- Docker (for PostgreSQL/Redis)
- PostgreSQL 15+

## Setup

### 1. Install Dependencies

```bash
# Frontend
cd frontend
npm install

# Backend
cd backend
npm install
```

### 2. Environment Variables

```bash
# Backend
cp backend/.env.example backend/.env
# Edit backend/.env with your database credentials
```

### 3. Database Migration

```bash
cd backend
node src/database/migrate.js
```

### 4. Run Development Servers

```bash
# Frontend (port 3001)
cd frontend
npm run dev

# Backend (port 3000)
cd backend
node src/server.js
```

### 5. Tests & Quality Gates

```bash
# Backend — jest: run `npm test` for current counts (integration.money skips without DATABASE_URL)
cd backend
npm test   # = node --experimental-vm-modules ./node_modules/jest/bin/jest.js (plain `npx jest` breaks attachments.test.js)

# Money integration suite against a throwaway PostgreSQL (adds integration.money):
docker run -d --name plankton-it-pg -e POSTGRES_USER=plankton -e POSTGRES_PASSWORD=plankton \
  -e POSTGRES_DB=plankton_it -p 5433:5432 postgres:16-alpine
DATABASE_URL='postgresql://plankton:plankton@localhost:5433/plankton_it' npm test
docker rm -f plankton-it-pg

# Frontend — jest (27 tests), lint (warning-only), i18n parity (33 × 483), production build
cd frontend
npm run lint && npm run i18n:check && npm test && npm run build

# Install scripts — must be clean (CI enforces)
shellcheck worker-app/*.sh && bash -n worker-app/*.sh
```

CI (`.github/workflows/ci.yml`) runs all of it on every push: backend jest with a
`postgres:16-alpine` service (so `integration.money` executes), frontend
`i18n:check` + jest (`npm test`) + `next build` + lint, `shellcheck worker-app/*.sh`,
and `node --check` over `worker-app/src/**/*.js`.

## Project Structure

### frontend/
Next.js 14 frontend with Tailwind CSS and i18n support.

```
frontend/
├── pages/
│   ├── index.js           # Chat homepage (state hub; UI split into components/chat/)
│   ├── profile.js         # Dashboard (balance, plans + token bundle, transactions card, earnings breakdown, rank card)
│   ├── workers.js          # Worker mgmt + Quick Install copy + history
│   ├── settings.js         # Settings (USD wallet, 33-lang dropdown, password)
│   ├── worker.js           # Worker docs: install/connect/delete + GitHub
│   ├── leaderboard.js     # Top workers/users
│   ├── support.js         # Support tickets: list/new/thread
│   └── admin.js           # Admin panel: 8 tabs + management actions
├── components/
│   ├── Navbar.js          # Nav + auth dropdown + LanguageSwitcher (🎫 Support: avatar dropdown + mobile menu + dashboard chips; top bar
│   ├── EarningsBreakdown.js # 5-way earnings breakdown (profile, /workers, /worker)
│   ├── PlansContent.js    # Pricing cards: shared by homepage section + modal
│   ├── PlansModal.js      # Pricing overlay for /#plans + Navbar event
│   ├── Footer.js          # Global version footer (every page)
│   ├── GoogleLogin.js     # Google OAuth
│   ├── ErrorBoundary.js   # Error boundary
│   ├── LanguageSwitcher.js # Dropdown: flag + language name (33 langs)
│   └── chat/              # Chat UI split (Sidebar, MessageList, Composer, UpgradeWall)
├── hooks/
│   └── useApi.js          # Abort-aware fetch hook (leaderboard)
├── i18n/
│   ├── translations.js    # Code-split registry: en static + 32 lazy loaders, LANGUAGES, RTL_LANGS, isRtl, hasLocale, loadLocale, detectLanguage
│   ├── translations/      # One file per language (33 files: en, fa, ar, ...)
│   └── LanguageContext.js  # Provider: browser detect + sessionStorage
└── styles/
```

### backend/
Node.js/Express API with PostgreSQL + Redis.

```
backend/
├── src/
│   ├── server.js          # Entry point
│   ├── models.js          # AI models + per-model pricing
│   ├── cache.js           # Redis caching
│   ├── database/
│   │   ├── pool.js        # PostgreSQL connection
│   │   └── migrate.js     # DB migration (25 tables + resource columns)
│   ├── middleware/
│   │   ├── auth.js        # JWT + Google OAuth (+ banned check via cached auth state)
│   │   └── validate.js    # Body validators (chat/register/deposit/withdraw)
│   ├── services/
│   │   └── plans.js       # PLANS catalog, getActivePlan, activatePlan, charge chain helpers
│   └── routes/
│       ├── auth.js        # Register/Login/Google
│       ├── chat.js        # LLM chat + payment chain + coverage wall
│       ├── workers.js      # Worker CRUD + model switch
│       ├── models.js      # Model list API
│       ├── payments.js    # NowPayments USD wallet (deposit/withdraw/IPN + plan/token IPN)
│       ├── plans.js       # Plan catalog (Plus/Pro/Max) + tier/token-bundle purchase
│       ├── token.js       # Balance snapshot
│       ├── tickets.js     # User support tickets
│       ├── admin.js       # Admin panel API: views + audited actions
│       └── leaderboard.js # Top workers
└── package.json
```

### worker-app/
Worker install/uninstall scripts and source code.

```
worker-app/
├── install-ubuntu.sh      # Ubuntu/Debian installer
├── install-redhat.sh      # RedHat/Fedora installer
├── install-macos.sh       # macOS installer (Homebrew + launchd; needs macOS 13+, fails fast below)
├── install-windows.ps1    # Windows installer (winget + Task Scheduler)
├── uninstall-ubuntu.sh    # Ubuntu/Debian uninstaller
├── uninstall-redhat.sh    # RedHat/Fedora uninstaller
├── uninstall-macos.sh     # macOS uninstaller
├── uninstall-windows.ps1  # Windows uninstaller
├── click.plankton.worker.plist  # launchd template
├── assets/                # Electron icon.png + tray-icon.png
└── src/                   # Worker source
    ├── main.js            # Electron desktop app
    ├── cli.js             # Headless CLI entry (no Electron)
    ├── renderer/index.html
    └── services/
        ├── ollama.js      # Ollama integration
        ├── worker.js       # CPU/RAM/GPU/Disk monitoring
        ├── websocket.js   # WebSocket to backend (resource metrics)
        └── api.js         # REST API (register, heartbeat)
```

## Database Schema (25 Tables)

| Table | Purpose |
|-------|---------|
| users | User accounts (email, Google OAuth; + `role`, `banned` |
| workers | GPU worker registrations |
| tasks | Chat task history |
| transactions | Token transactions |
| staking | Staking records |
| user_balances | PLANKTON token balance |
| deposits | Deposit history |
| api_keys | API key management |
| user_coin_balances | Multi-coin balances (7 coins) |
| coin_deposits | Crypto deposit history |
| coin_withdrawals | Crypto withdrawal history |
| worker_coin_earnings | Worker earnings per coin (`source`: wallet/tokens + `plan_type`: free/plus/pro/max breakdown) |
| chat_sessions | Chat session groups |
| **daily_tokens** | Daily free allowance — signed-in users; |
| **worker_daily_credit** | Free daily chat credit for worker hosts ($1/UTC-day) |
| **daily_tokens_guest** | Daily free allowance — guests, keyed by client IP |
| **user_plans** | Active subscription tiers (`plus`/`pro`/`max`: 10M/30M/80M tokens/day; plus |
| **plan_purchases** | Plan/token invoice claims — IPN exactly-once idempotency (`plan_type`: plus/pro/max/tokens) |
| **user_token_balances** | Prepaid token pot — $1 = 1M tokens, never expires |
| **tickets** | Support tickets — subject, category (`support`/`billing`/`worker`), status (`open`/`answered`/`closed`), |
| **ticket_messages** | Ticket thread messages (`is_admin` flags the staff reply, `ON DELETE CASCADE`), |
| **admin_audit_log** | Admin mutation trail — `admin_id`, `action`, `target_type/id`, `reason`, `payload JSONB`, |
| **schema_migrations** | Migration bookkeeping (applied version rows) |

### Workers Table — Resource Monitoring Columns

| Column | Type | Purpose |
|--------|------|---------|
| gpu_usage | numeric(5,2) | GPU VRAM usage percentage |
| ram_usage | numeric(5,2) | RAM usage percentage |
| cpu_usage | numeric(5,2) | CPU usage percentage |
| disk_usage | numeric(5,2) | Disk usage percentage |

**Important:** PostgreSQL `numeric` columns return as **strings** in node-postgres. Always use `parseFloat()` before `.toFixed()` or arithmetic.

## AI Models & Pricing

Models defined in `backend/src/models.js` with per-model pricing:

```javascript
{
  id: 'llama3.1:8b',
  name: 'Llama 3.1',
  size: '8B',
  ram: '5 GB',
  category: 'chat',
  desc: 'Best budget all-rounder',
  inputPrice: 0.079,   // per 1M tokens
  outputPrice: 0.158   // per 1M tokens
}
```

### Pricing Table (vs DeepSeek V4 Flash)

| Model | Size | Input/1M | Output/1M | vs DeepSeek |
|-------|------|----------|-----------|-------------|
| nomic-embed-text | 274M | $0.070 | $0.140 | -50% |
| llama3.2:3b | 3B | $0.071 | $0.142 | -49% |
| embeddinggemma | 300M | $0.073 | $0.146 | -48% |
| bge-m3 | 567M | $0.076 | $0.152 | -46% |
| llama3.1:8b | 8B | $0.079 | $0.158 | -44% |
| qwen3-vl:8b | 8B | $0.082 | $0.164 | -42% |
| gemma4:12b | 12B | $0.085 | $0.170 | -40% |
| phi4:14b | 14B | $0.086 | $0.172 | -39% |
| gpt-oss:20b | 21B MoE | $0.088 | $0.176 | -37% |
| mistral-small3.2:24b | 24B | $0.090 | $0.180 | -36% |
| qwen3-coder:30b | 30B | $0.091 | $0.182 | -36% |
| gemma3:27b | 27B | $0.092 | $0.184 | -34% |
| qwen2.5-coder:32b | 32B | $0.094 | $0.188 | -34% |
| qwen3:32b | 32B | $0.095 | $0.190 | -32% |
| llama3.3:70b | 70B | $0.097 | $0.194 | -32% |
| deepseek-r1:70b | 70B | $0.098 | $0.196 | -30% |

## Daily Free Allowance & Plans

Every subject gets a **2,000,000-token free allowance per UTC day** —
signed-in users in `daily_tokens` (keyed by `user_id`), guests in
`daily_tokens_guest` (keyed by `req.ip`; `trust proxy` is set in
`server.js`). Paid tiers raise the cap for 30 days: **Plus $4.99 → 10M,
Pro $9.99 → 30M, Max $19.99 → 80M tokens/day** (`PLANS` in
`src/services/plans.js`). A separate **token bundle** ($1 = 1M, never
expires) tops up a prepaid pot (`user_token_balances`).

### Payment chain (one row-locked transaction in `chat.js`)

1. **Coverage pre-flight (before dispatch)**: free remaining > 0 OR worker
   credit remaining > 0 OR token pot > 0 OR wallet > 0? If *nothing*
   covers the next message → `402 { code: 'upgrade_required', free,
   plans, token_bundle, signed_in }` — the wall. Pre-flight query failures
   **never block** (availability first).
2. `chargeFreeTokens()` — the daily allowance upsert (row-locked, UTC-day
   rollover in the same statement). Covered → `payment_status: "free"`,
   no wallet debit, **no worker revenue share**.
3. `chargeWorkerCredit()` (v3.25, signed-in only) → `"free_worker"`.
4. **Token pot** (v3.28, signed-in only) — `chargeTokenPot()` deducts the
   message's full token count all-or-nothing (`UPDATE … WHERE tokens >=
   $n RETURNING tokens`, race-safe). Covered → `"tokens"` +
   `token_balance_remaining`; the worker earns `cost × WORKER_REVENUE_SHARE`
   (flat 90%) with `source = 'tokens'`, paid from bundle revenue.
5. USD wallet (signed-in only) — worker gets a **flat 90%** regardless of
   the payer's plan, with `source = 'wallet'` and the payer's
   `plan_type` recorded. A balance **below** the cost is drained in full
   (`debit = min(cost, balance)`) so the wallet reaches exactly $0 and the
   next message hits the wall instead of parking at dust forever.
   Covered → `"paid"` + `notice: "upgrade_recommended"` (frontend shows a
   once-per-UTC-day dismissible banner with the catalog).
6. Nothing covers (a race after pre-flight) → the reply, which already
   exists, is served as `"free"` — generation is never wasted or blocked.

### Plans

- `GET /api/plans` (auth optional) — `{ plans: [...with value metrics],
  plan, daily_limit, token_bundle, free_tokens?, token_balance? }`.
  Value metrics (`value_usd_day`/`value_usd_month`) price the allowance at
  the default model's catalog output price (`outputPrice()` ≈ $0.158/1M).
- `POST /api/plans/:tier/purchase` (auth) — validates `:tier` against
  `PLANS` (`400 INVALID_PLAN` otherwise), creates a NowPayments invoice
  with `order_id = <tier>-<userId>-<ts>` and a pending `plan_purchases`
  row (`plan_type` = tier).
- `POST /api/plans/tokens/purchase` (auth, before `/:tier` so `tokens`
  can never be read as a tier) — whole dollars `$1–$500` (at least
  `nowpayments.getMinUsdDeposit()`), `order_id = tok-<userId>-<ts>`,
  pending row with `plan_type = 'tokens'` + quoted token count.
- IPN (`POST /api/payments/deposit/webhook`): orders prefixed
  `plus-`/`pro-`/`max-`/`tok-` claim their `plan_purchases` row
  (`status = 'pending'` → `'completed'`, exactly-once under replay) and
  then `activatePlan(userId, tier)` or `creditTokens()`. Wallet credit
  only happens for legacy `plankton-…` deposit orders.
- `activatePlan()`: `expires_at = GREATEST(expires_at, now()) + 30 days`
  per tier row — renewing mid-cycle never loses days. Multiple active
  rows are allowed; `getActivePlan()` returns the best cap (no proration,
  no downgrade).
- Expiry is passive: `getActivePlan()` requires `expires_at > now()`, so
  an expired row silently falls back to the Free cap.
- Attribution: `worker_coin_earnings.source` + `.plan_type` are written on
  paid legs only; `GET /api/leaderboard/mine` aggregates them into
  `breakdown: {tokens, wallet, plus, pro, max}` for the profile.

### Rules

- Reset at UTC midnight: `last_reset_date = (now() AT TIME ZONE 'utc')::date`
  (identical contract to `workerCredit`); a stale row counts as unused.
- Allowance is counted in `tokensUsed` (the same output-token count that
  drives `cost`), so Free and pricing always agree.
- Balance endpoints expose `free_tokens: { limit, used, remaining }`,
  `plan: { name, active, expires_at }`, `plans: [...]` and
  `token_bundle: {..., balance}`; the chat response carries
  `free_tokens_remaining` and (on the pot leg) `token_balance_remaining`.
- Known limitations (documented in AUDIT): the 2M cap is a promise, not
  throughput — the CPU box sustains ~0.58M tokens/day, so one maxing user
  can saturate it until workers arrive; guests behind one NAT IP share an
  allowance.
- Tests: `backend/tests/free.allowance.test.js`, `backend/tests/plans.test.js`.

### Pricing surfaces

- Inline section: the empty homepage renders `PlansContent` below `#plans`
  (hidden once a chat starts); `GET /api/plans` is `optionalAuth` so
  signed-in users see tier notes without a token being required.
- Modal: `PlansModal` hosts the same `PlansContent` in an overlay and
  opens from (a) the `/#plans` URL hash on mount or `hashchange`, (b) the Navbar
  `⭐ Plans` links, which dispatch a `plankton:show-plans` CustomEvent. `closePlans()`
  clears `location.hash`. Both surfaces sit **above** the chat frame, so `/#plans`
  works in any state (logged-out, sidebar, mid-conversation).

## Worker Free Chat Credit

Signed-in users with at least one worker in `online`/`busy` state get a
**$1.00 chat allowance per UTC day**. The credit is platform-funded: spending
it never debits the wallet and never credits a worker — the worker pool is only
touched by paid chats.

### Flow (within the chain)

1. Runs **second** in the payment txn, after the daily free allowance
   (`chargeFreeTokens`) and before the token pot/wallet — an `INSERT … ON
   CONFLICT` upsert row-locks the credit row and rolls a stale
   (pre-UTC-today) usage to zero in the same statement, so parallel
   requests cannot overspend.
2. Covered → `payment_status: "free_worker"` — no wallet debit, **no
   `WORKER_REVENUE_SHARE`**, no `worker_coin_earnings` row.
3. Not covered → the token pot, then the wallet path exactly as before
   (flat 90% worker share on paid legs).
4. Neither covers (race) → the reply is still served with
   `payment_status: "free"`; a subject that had *no* coverage at all was
   already walled by the pre-flight.
5. Guests never reach the credit (signed-in only).

### Rules

- Reset at UTC midnight: `last_reset_date = (now() AT TIME ZONE 'utc')::date`.
- Eligibility is checked **at charge time** — registering a worker row is not
  enough; it must actually be `online`/`busy`.
- Balance endpoints expose `worker_credit: { eligible, limit, used, remaining }`;
  the chat response carries `worker_credit_remaining`.
- Tests: `backend/tests/worker.credit.test.js`.

## Wallet Integration

### Supported Wallets

| Wallet | Detection | Provider |
|--------|-----------|----------|
| MetaMask | `window.ethereum?.isMetaMask` | EIP-1193 |
| Trust Wallet | `window.ethereum?.isTrust \|\| window.ethereum?.isTrustWallet` | EIP-1193 |

### How it works

Both wallets use the same EIP-1193 standard. The only difference is the detection flag.

### Frontend flow (profile.js)

```
1. User clicks "Connect Wallet" → shows 2 buttons
2. MetaMask button → checks window.ethereum?.isMetaMask
3. Trust Wallet button → checks window.ethereum?.isTrust
4. Both use: provider.request({ method: 'eth_requestAccounts' })
5. If wallet not installed → opens download page
6. After connection → shows wallet address + which wallet
```

## Support Tickets & Admin Panel

### Schema

- `tickets(id, user_id, subject ≤200, category, status, created_at, updated_at)` — `category ∈ support|billing|worker`, `status ∈ open|answered|closed`; indexes on `(user_id, id DESC)` and `(status, updated_at DESC)`.
- `ticket_messages(id, ticket_id CASCADE, user_id, is_admin, body ≤4000, created_at)` — a ticket is always created with its first user message in one transaction, so an empty thread cannot exist.
- `admin_audit_log(id, admin_id, action, target_type, target_id, reason, payload JSONB, created_at)` — every admin mutation inserts its row **inside the same transaction** as the change: an action either lands with its trail or not at all.
- `users.banned BOOLEAN` — orthogonal to `role`; enforced at `POST /api/auth/login` (403) and on every authenticated request via the cached auth state in `middleware/auth.js` (`SELECT token_version, banned` cached 10s, fail-open on lookup errors like the rest of that layer). Ban/role changes call `invalidateTokenVersion()` so live sessions die within one cache window.

### Status flow

`open` (waiting on staff) → `answered` (admin reply) → back to `open` on a user reply → `closed` (either side; user reply to a closed ticket → 409, admin reply to a closed ticket → 409). Admin can reopen.

### Routes

- **User (`routes/tickets.js`, limiter `tickets` 10/5min):** `POST /api/tickets`, `GET /api/tickets`, `GET /api/tickets/:id`, `POST /api/tickets/:id/messages`, `POST /api/tickets/:id/close` — owner-only (another user's ticket → 403, missing → 404).
- **Admin (`routes/admin.js`, `authenticate + requireAdmin`):** tickets `GET /tickets?status=&q=`, `GET /tickets/:id`, `POST /tickets/:id/messages` (→ `answered`), `POST /tickets/:id/status` (`open`/`closed`); users `PUT /users/:id/role` (self-change → 409), `PUT /users/:id/ban` (self-ban → 409), `POST /users/:id/balance` (±USD, row-lock + floor at 0 + reason), `POST /users/:id/tokens` (±token pot), `PUT /users/:id/plan` (grants via `plans.activatePlan` → +30 days); workers `PUT /workers/:id/status` (`removed` ↔ `offline`); views `GET /payments`, `GET /purchases` (with owner email). `GET /users` returns `banned`, USD/token balances and the active plan for the action dialogs; the dashboard also counts total/open tickets.

### UI

- `/support`: list + new-ticket form + thread with replies/close; `🎫 Support` entry in the Navbar avatar dropdown + mobile menu for everyone (desktop top-bar link removed; quick-nav chip on dashboard pages), `🛡️ Admin` only when `role === 'admin'`.
- `/admin`: 8 tabs — dashboard (6 cards), users (manage drawer: role, ban/unban, ±USD, ±tokens with mandatory reason, grant plan), workers (remove/restore), tasks, tickets (search/filter + thread reply/close/reopen), payments (deposits + withdrawals), purchases, orgs. Strings i18n'd (`admin.*`, `support.*` — 33 × 483 keys).
- `/profile`: read-only **Transactions** card merging `/api/payments/history` deposits + withdrawals (newest first, status badges, link to `/settings`).

### Tests

`backend/tests/tickets.test.js` (8), `admin.tickets.test.js` (6), `admin.actions.test.js` (8) — mocked-pool pattern, asserting status codes, the SQL that ran (`BEGIN`/`COMMIT`, audit inserts) and the ban 403 path.

## Internationalization (i18n) — 33 languages

### How it works

- Language files: `frontend/i18n/translations/<code>.js` (one per language, full key set)
- Registry: `frontend/i18n/translations.js` exports `translations` (sync registry, starts with `en`), `LANGUAGES` (code/name/flag/rtl), `RTL_LANGS`, `isRtl()`, `hasLocale()`, `loadLocale()`, `detectLanguage()`
- **Code-split:** only `en` is statically imported; the other 32 locales load as webpack chunks via literal `() => import('./translations/<code>')` loaders (`_app` shrank from ~500 kB to ~27 kB raw). `changeLang()` waits for the chunk before committing so the switch never flashes English
- **Detection (first visit):** `sessionStorage['plankton-lang']` → else `navigator.languages` match → else `en`
- **User choice:** stored in `sessionStorage['plankton-lang']` (persists while user is on the site / same tab)
- **RTL:** `fa`, `ar`, `he`, `ur` — `document.documentElement.dir` set by LanguageContext
- Fallback: missing keys (and a still-loading locale chunk) fall back to English (`t()` walks `translations[lang]` then `translations.en`)

### Adding a new language

1. Copy `frontend/i18n/translations/en.js` → `<code>.js` and translate all values
2. Register a loader in `frontend/i18n/translations.js`: add the `{ code, ... }` row to `LANGUAGES` and a `code: () => import('./translations/<code>')` entry to `loaders` (`en` stays the only static import)
3. Run `npm run i18n:check` — it fails unless the new file matches `en.js` key-for-key and every referenced key exists

### Translation Keys (Profile)

```
t('profile.available')   → "Available" / "موجود"
t('profile.earned')      → "Earned" / "کسب شده"
t('profile.spent')       → "Spent" / "مصرف شده"
```

## Worker CLI Mode

For headless servers (no desktop/Electron), the service runs `cli.js` directly
(there are **no CLI flags** — `cli.js` reads `worker-app/config.json` only):

```bash
# token/email live in config.json, written by the install script
cat "$HOME/plankton-worker/worker-app/config.json"
systemctl start plankton-worker
```

To change the token or account, re-run the install script (it rewrites
`config.json` and re-registers the worker).

### Systemd Service

The install script creates `/etc/systemd/system/plankton-worker.service`:

```bash
systemctl start plankton-worker
systemctl stop plankton-worker
systemctl status plankton-worker
journalctl -u plankton-worker -f  # live logs
```

Service auto-starts on boot via `systemctl enable`.

## Auth System

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/register | Register (email + password) |
| POST | /api/auth/login | Login (email + password) |
| POST | /api/auth/google | Google OAuth |
| POST | /api/auth/set-password | Set password (Google-only users) |
| POST | /api/auth/change-password | Change password |
| POST | /api/auth/forgot-password | Request password reset |
| POST | /api/auth/reset-password | Reset with token |

### Worker Token

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/workers/token | Generate/get worker token |
| POST | /api/workers/setup | Register worker (with token) |

Worker token format: `pw_` + 32 hex bytes (67 chars)

### Session expiry

Frontend calls go through `lib/apiFetch.js`: on a 401 it clears the stored token
and fires `plankton:auth-changed` **before** rejecting (the Navbar, profile, workers
and settings pages listen and bounce to login instead of rendering stale auth
state). `GET /api/plans` is public — `optionalAuth` — so the pricing
catalog never 401s; every other protected route returns 401 as documented in
`docs/api.md`.

## Multi-Worker Accounts

One user can run **unlimited workers**, add/remove/rename from profile. No cap.

### Identity: one unique token per worker
- `POST /api/workers` (auth) creates a worker row + unique `worker_token`.
  The token IS the worker identity — no two servers can collide.
  Empty name defaults to **`worker1`**.
- Install that server with **its own token** (`--token`); `/setup` and WS
  `auth` bind directly by token.
- **Single-use display:** `workers.token_used_at` is set on first
  successful `/setup` or WS auth. `GET /api/workers/mine` then returns
  `worker_token: null` (token stays in DB for re-auth).
  `PUT /api/workers/mine/:id/token` rotates the token and clears the flag
  (for reinstalling the same machine).
- Profile shows a **guide modal** on first visit and every time before Add Worker.
- Legacy account token (`users.worker_token`) still works only when the user
  has exactly 1 active worker; otherwise the API asks for the per-worker token.
- `machine_id`/`name` columns from are kept for display/compat but no
  longer used for lookup.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/workers | Create worker for current user → row + unique token |
| PUT | /api/workers/mine/:id/token | Rotate token for reinstall, clear `token_used_at` |
| POST | /api/workers/setup | Bind by per-worker token; legacy account token only if exactly 1 active worker |
| GET | /api/workers/mine | Array `workers` (+ legacy `worker` = first, backward compat) |
| PUT | /api/workers/mine/model | Switch model; body `{ model, worker_id? }` |
| PUT | /api/workers/mine/:id | Rename (own workers only) |
| DELETE | /api/workers/mine/:id | Soft delete → `status='removed'` (history preserved) |

### Lifecycle rules
- Removed workers are excluded from dispatch (only `status='online'` gets tasks).
- WS auth rejects `removed`/unknown tokens (`auth_error`); reinstalling with
  the same per-worker token revives its row (sets back to `online`).
- Concurrent connections with the same token: newest wins, old socket is
  closed; worker re-authenticates automatically on `Not authenticated`.
- In-memory WS registry and heartbeat/cleanup are already keyed by `worker.id`,
  so no changes were needed there.

### Worker app changes
- `websocket.js`: token-only `auth`; re-auth on `Not authenticated` (guarded);
  `servername` SNI for direct-IP TLS.
- `cli.js` / `main.js`: read `worker_token` from `config.json`.
- Install scripts: prompt for name (`--name` flag supported), saved to
  `config.json` and sent in `/setup` POST (display only).

## Uninstall

Interactive menu:

```
1) Worker only (service + app files)
2) Everything (worker + Ollama + all downloaded models)
0) Cancel
```

**Option 1:** stops service, disables, removes files
**Option 2:** Option 1 + removes Ollama binary + ~/.ollama/ models + ollama user

## Smart Model Fallback

Retired: worker-only inference serves the exact requested model or fails
explicitly — no workers → `503 WORKER_OFFLINE` (retryable wait), model missing →
`409 MODEL_UNAVAILABLE` with `alternatives`. The old local-Ollama substitution
(`GET /api/tags` → family match → first available) and the server Ollama
itself were removed.

## Organization Plans

- Tables `orgs` + `org_members` (one active membership per user, no cap).
  The org shares the leader's plan cap as one `daily_tokens` bucket
  (`services/org.js` resolveCap = max(own, org)); worker credit/pot/wallet
  stay per-user; attribution aggregates `tasks` per member (30d).
- Routes: `/api/orgs` (mine/usage/members/transfer/leave) + `/api/admin/orgs`
  (create/add/remove/disband, audited). Leader leaves → oldest promoted.
- UI: `/org` page + 8th admin tab + Navbar link.

## Worker Routing

- Multi-model: workers report `models[]` at auth + heartbeat; dispatch matches
  the list (legacy: `current_model` only). 3 consecutive task errors down-mark
  a model for that worker (success resets).
- Selection: sticky session → weighted round-robin (GPU-tier score) for new
  sessions → spill past 2 in-flight tasks. Guests: pure WRR per message.
- Context: last 10 turns / ~6k tokens (16k hard cap) sent as `history` to
  `app_version >= 3.41` workers only; billing stays output-only.
- Installer: re-running on an installed box opens the manager menu
  (add/remove/repair models, token/name, update, restart). Smoke-test with a
  fake HOME: `HOME=/tmp/fakehome bash worker-app/install-ubuntu.sh`.


### Capability protocol (1.0.0)

Workers send `protocol: 2` in their `auth` message. `ws.js` treats any
`protocol >= 2` worker as able to receive `attachment` (images/voice) and
`history` (conversation window) on task messages. Binaries that predate 1.0.0
send no protocol and fall back to the old app-version gates (media ≥ 3.20,
history ≥ 3.41). Bump `FULL_PROTOCOL` (server) and `PROTOCOL`
(`worker-app/src/services/websocket.js`) together when the task message format
changes. Never gate on the app version again: it was reset at 1.0.0.

`protocol: 3` (current worker app) also answers `embed` messages:
`{type:'embed', task_id, model, input: string[]}` → `{type:'embed_result',
task_id, embeddings: number[][], tokens_used}` (both encrypted under E2E). The
server only routes embeddings to `protocol >= 3` workers (`EMBED_PROTOCOL` in
`ws.js`) and validates the vectors (count, finite numbers, equal dims ≤ 8192).
`services/embeddings.js` is the single path for `/v1/embeddings` and chat RAG;
installers always add `bge-m3` and refuse to remove it in the manager menu.

### Schema rename on upgrade (1.0.0)

`migrate.js` starts by renaming a pre-1.0 database in place (old table,
column, index and sequence names to their `worker` equivalents, plus stored
role/category/audit values). Every step is guarded, so running it on a fresh
or already-migrated database is a no-op. Take a backup first
(`scripts/backup-db.sh`).
## Coder API

- OpenAI-compatible `/v1` (2 coders): `GET /v1/models`, `POST /v1/chat/completions`.
  Keys: `sk_...` via `/api/keys` (JWT dashboard), sha256-only storage.
- Gate: pot/wallet/paid-plan or `402 api_payment_required`. Caps = ownership.
  Rate limit 120/min on `/v1/` (agent loops). Billing = shared
  `services/billing.js` settleMessage (chat + v1; output-only).
- Manual e2e: mint key in Settings → `curl /v1/models` → `curl
  /v1/chat/completions` → opencode with `qwen3-coder:30b` → check spend.

## Installer / Uninstaller Self-Cleanup

Install scripts auto-delete themselves after successful installation:

```bash
rm -f "$0"  # Last line of install-ubuntu.sh / install-redhat.sh
```

Uninstall scripts (`uninstall-ubuntu.sh` / `uninstall-redhat.sh`) self-delete
too, but only after the removal actually succeeded (options `1`/`2`). Cancel, an
invalid choice, or a failed step (`set -e` exits first) leaves the file on disk
so it can be rerun. The `head` check identifies the script by its header, so a
piped run — `curl | bash`, where `$0` is the shell itself — never deletes
anything that is not this script:

```bash
SELF="$0"
if [ "$SUCCESS" = "1" ] && [ -f "$SELF" ] && head -n 6 "$SELF" | grep -q "Plankton Network Worker - .* Uninstall"; then
  rm -f -- "$SELF"
fi
```

## Mobile UI

The site is designed phone-first. Invariants to keep when touching the frontend:

- **Keyboard vs. fixed frame** — the chat page is a `100dvh` `overflow-hidden` frame. iOS does *not* shrink the layout viewport when the keyboard opens, so while an `input`/`textarea` is focused `pages/index.js` measures `window.visualViewport` and writes `--app-vv-height` / `--app-vv-shift` on `<html>`; `pages/_app.js` consumes them as the frame's `height` / `translateY`. Always set `interactive-widget=resizes-content` and `viewport-fit=cover` in `_document.js`; never add `maximum-scale` (accessibility violation + iOS ignores it anyway).
- **No focus zoom** — iOS zooms any focused field under 16px. `styles/globals.css` forces `font-size: 16px !important` on `input/textarea/select` at ≤767px, which intentionally beats Tailwind's `text-sm`. New inputs are covered automatically; do not override with inline font sizes.
- **Touch targets** — any tappable control ≥40px (44px for primary nav ☰/✕). Hover-only affordances are banned on mobile (session delete is `md:hidden md:group-hover:flex`).
- **No transform ancestors for fixed overlays** — the mobile nav (`Navbar.js`) and chat sidebar drawer use `fixed` positioning; the sidebar closes on session pick (`loadSession`) and the nav closes on route change (`useRouter`).
- **Layout helpers** — composer groups use `md:contents` so mobile gets stacked rows while desktop keeps a single flex row; wallet grids are `grid-cols-1 sm:grid-cols-3`.
- **Safe areas** — bottom paddings use `pb-[max(1rem,env(safe-area-inset-bottom))]` (chat frame, footer, bottom-sheet modal).

## VPS Deployment

### Server Info

Host/IP, SSH user and key live in the private ops vault — never commit them to this repository.

| Item | Value |
|------|-------|
| IP / host | *(private vault)* |
| OS | Ubuntu 24.04 |
| User | *(non-root deploy user)* |
| Backend | /opt/plankton/backend |
| Frontend | /opt/plankton/frontend |

### Deploy Commands

```bash
# SSH into server (use your ops alias; do not commit hostnames/IPs)
ssh <deploy-host>

# Run migration (after DB schema changes)
cd /opt/plankton/backend
node src/database/migrate.js

# Rebuild frontend
cd /opt/plankton/frontend
npm run build

# Restart services
systemctl restart plankton-backend
systemctl restart plankton-frontend
```

### Services

```bash
systemctl status plankton-backend
systemctl status plankton-frontend
systemctl status nginx
docker ps  # plankton-postgres, plankton-redis
```

### Quick Deploy from Local

```bash
rsync -az --exclude .git --exclude .next --exclude node_modules --exclude '.env*' \
  plankton-public/ <deploy-host>:/opt/plankton/
ssh <deploy-host> 'cd /opt/plankton/frontend && npm run build && \
  systemctl restart plankton-frontend plankton-backend'
curl -s https://plankton.click/health   # must report the new version
```

### Version Bump

One command updates every canonical marker — the three `package.json`s, both
lockfiles, the 6 shell + 2 PowerShell worker scripts, all 33 locale footers and
the `docs/api.md` header:

```bash
node scripts/bump-version.js 1.0.1   # add the CHANGELOG section yourself
```

`backend/tests/version.parity.test.js` fails the build if any surface is out
of sync, so CI catches a missed file. Historical version mentions in comments
and CHANGELOG sections are intentionally left alone.

### Database Backups

Encrypted nightly backups run from a systemd timer (03:30 UTC):

```bash
# One-off setup on the server:
mkdir -p /etc/plankton
cp /opt/plankton/deploy/backup.env.example /etc/plankton/backup.env && chmod 600 /etc/plankton/backup.env
openssl rand -base64 32 > /etc/plankton/backup.pass && chmod 600 /etc/plankton/backup.pass
cp /opt/plankton/deploy/plankton-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now plankton-backup.timer

# Run one backup now + inspect:
/opt/plankton/scripts/backup-db.sh
ls -l /var/backups/plankton/

# Restore drill (safe: restores into a throwaway DB, then drop it):
/opt/plankton/scripts/restore-db.sh "$(ls -t /var/backups/plankton/*.enc | head -1)"
docker exec plankton-postgres psql -U plankton -d postgres -c 'DROP DATABASE plankton_restore_test'

# Real restore over the live DB (last resort — requires --force):
systemctl stop plankton-backend
/opt/plankton/scripts/restore-db.sh /var/backups/plankton/<file>.enc plankton --force
systemctl start plankton-backend
```

- **Passphrase**: `/etc/plankton/backup.pass` (600, root). Keep a copy in the
  password manager — without it offsite dumps are undecryptable. Restore
  refuses to touch the live DB unless `--force`.
- **Offsite**: set `BACKUP_REMOTE` (rclone syntax, e.g. `b2:plankton-backups`)
  in `/etc/plankton/backup.env`; install + configure rclone (`rclone config`).
  Until then, backups are local-only — a lost VPS loses them.
- **Retention**: `BACKUP_RETENTION_DAYS` (default 14). Dumps smaller than
  10KB are treated as failed runs and never replace anything.

### Filtered-network access

The tunnel / edge-proxy / relay setup for visitors on filtered networks is
kept in the private ops repo, not here.

## Troubleshooting

### npm install fails

```bash
rm -rf node_modules package-lock.json
npm install
```

### Port already in use

```bash
lsof -i :3000
kill -9 <PID>
```

### Build fails

```bash
rm -rf frontend/.next
cd frontend && npm run build
```

### Frontend not updating

```bash
systemctl restart plankton-frontend
```

### Database connection issues

```bash
docker exec plankton-postgres psql -U plankton -d plankton -c "SELECT 1"
```

