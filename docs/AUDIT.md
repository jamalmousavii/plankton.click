# Plankton Network — Code Audit & Remediation Report

**Date:** 2026-09-26
**Scope:** `plankton-public/` (backend Express/`pg`/`ws`, Next.js 14 frontend, Electron/CLI worker app, install scripts, nginx/systemd deploy files, docs)
**Constraint:** production (`https://plankton.click`) is **live with real users** — every change is backward-compatible; migrations are additive and idempotent.
**Verdict:** 4 critical, 12 high and 20+ medium findings. **All code findings below marked `FIXED` are implemented and verified in this working tree**; items marked `OPEN` remain and are listed in §7 with a recommended next step.

> **خلاصه به فارسی:** این گزارش یافته‌های امنیتی و مالی پروژه را با ذکر فایل و خط نشان می‌دهد. مهم‌ترین باگ — بازنشانی سهمیه روزانه در هر درخواست (استفاده نامحدود رایگان) — همراه با لو رفتن توکن ریست پسورد، کش کردن پاسخ‌های احراز هویت‌شده، و بازپرداخت وب‌هوک پرداخت، رفع شده است. تست‌ها (`backend/tests/`) و CI اضافه شده‌اند. موارد باقی‌مانده در بخش ۷ آمده است.

---

## 1. Method

1. Full read of backend source (`backend/src/**`), frontend pages/components, worker app, install scripts, deploy configs.
2. Static review for auth/authorization, money flow, concurrency, input validation, logging, availability.
3. Runtime verification where a dependency was available (see §6): `node --check` on every source file, backend boot smoke test, `next build`, `jest` suite.
4. Every fix is additive (no breaking API changes) or returns an explicit `410 Gone` for endpoints that were already unreachable from the shipped frontend.

---

## 2. Findings at a glance

| ID | Sev | Area | Finding | Location | Status |
|----|-----|------|---------|----------|--------|
| C1 | **Critical** | Money | Daily 1000-token allowance reset on **every request** → unlimited free paid-model usage | `backend/src/database/pool.js:11`, `backend/src/routes/chat.js:97-111` | FIXED |
| C2 | **Critical** | Security | Password-reset token returned in API response and logged (account takeover in 2 requests) | `backend/src/routes/auth.js:270-320` | FIXED |
| C3 | **Critical** | Security | Response cache keyed by URL only — could serve one user's data to another (mitigated only by where `cacheMiddleware` was mounted) | `backend/src/cache.js:39-64` | FIXED |
| C4 | **Critical** | Money | NowPayments IPN: no fail-closed, no replay protection → double credit / forged credit | `backend/src/services/nowpayments.js:73-95`, `backend/src/routes/payments.js:72-160` | FIXED |
| H1 | High | Security | `role=admin` accepted at self-registration; admin decided by JWT claim alone | `backend/src/middleware/validate.js:20`, `backend/src/middleware/auth.js:46-80` | FIXED |
| H2 | High | Security | JWT verification accepted any algorithm (incl. `alg:none`) | `backend/src/middleware/auth.js:14` | FIXED |
| H3 | High | Security | `GET /api/workers` returned `wallet_address` for every worker, unbounded | `backend/src/routes/workers.js:11-24` | FIXED |
| H4 | High | Security | `GET /api/workers/:id` public → leaked wallet + earnings of any worker | `backend/src/routes/workers.js:397` | FIXED |
| H5 | High | Money | Legacy `/api/token/deposit|deduct|transfer` allowed client-driven balance changes | `backend/src/routes/token.js:61-73` | FIXED (410) |
| H6 | High | Money | Withdraw checked balance then debited (two statements) → concurrent double-spend | `backend/src/routes/payments.js:190-240` | FIXED (atomic) |
| H7 | High | Money | Worker credited `earnings` even when a **cloud/local** fallback answered the task | `backend/src/routes/chat.js:468,529` | FIXED |
| H8 | High | Availability | `/health` always `200`, even with Postgres down → LB never drains the node | `backend/src/server.js:158-196` | FIXED |
| H9 | High | Ops | Production IP + `ssh root@…` committed in docs | `DEVELOP.md:492,502` | FIXED (redacted) |
| H10 | High | Ops | systemd unit ran the **Electron** app as root with a hardcoded wallet address | `deploy/plankton-worker.service` | FIXED |
| H11 | High | Availability | No graceful shutdown / no `unhandledRejection` handling → dropped in-flight work on deploy | `backend/src/server.js:206-270` | FIXED |
| H12 | High | DX | Zero automated tests, no CI | `backend/tests/`, `.github/workflows/ci.yml` | FIXED (43 tests) |
| M1 | Medium | Security | Guest chat had no separate rate limit (shared 30/min, per-IP spoofable behind proxy) | `backend/src/server.js:136-142` | FIXED |
| M2 | Medium | Security | WS trusted `cf-connecting-ip` (any client could send it) for replay/replacement rules | `backend/src/ws.js:18-30` | FIXED |
| M3 | Medium | Money | `payments/deduct` read-then-write race | `backend/src/routes/payments.js:312-346` | FIXED |
| M4 | Medium | Money | `stats` counted "tokens burned" as `cost*0.01`, admin used `cost*0.1` — two definitions of the same number | `backend/src/routes/stats.js`, `admin.js:18` | FIXED (single 10% definition) |
| M5 | Medium | Money | `heartbeat` accepted arbitrary `status` / unbounded `tasks_completed` and could resurrect a removed worker | `backend/src/routes/workers.js:351-395` | FIXED |
| M6 | Medium | Money | `/api/workers/setup` revived `removed` workers that `ws.js` would then refuse | `backend/src/routes/workers.js:292` | FIXED (401) |
| M7 | Medium | Correctness | Default model disagreement: `llama3:8b` (chat) vs `llama3.1:8b` (catalog) | `backend/src/routes/chat.js:16` | FIXED |
| M8 | Medium | Correctness | `/api/models` credited unknown models to the `llama3.1:8b` badge (misleading availability) | `backend/src/routes/models.js:15-50` | FIXED |
| M9 | Medium | Money | Chat had no pre-flight balance check → expensive inference ran, then failed | `backend/src/routes/chat.js:116,295` | Superseded twice: v3.26.0 removed the pre-flight on purpose; **v3.27.0 restores a coverage-only pre-flight** — zero coverage → `402 upgrade_required` *before* dispatch, partial coverage still never blocks |
| M10 | Medium | Robustness | Chat accepted non-integer `session_id` and 65k subjects → SQL type errors (500) instead of 400 | `backend/src/routes/chat.js` session CRUD | FIXED |
| M11 | Medium | Robustness | `migrate.js` exited `0` on failure | `backend/src/database/migrate.js` | FIXED |
| M12 | Medium | Ops | `console.*` scattered through the API (no level/structure/rotation) | throughout `backend/src` | FIXED (pino) |
| M13 | Medium | Frontend | `window.location` redirect **during render** on 3 pages (hydration flash / React warning) | `pages/profile.js`, `settings.js`, `workers.js` | FIXED (`useAuth`) |
| M14 | Medium | Frontend | `.toFixed()` on `pg` numeric **strings** → TypeError → whole page crash | `pages/admin.js`, `explorer.js`, `leaderboard.js` | FIXED |
| M15 | Medium | Frontend | No 404/500 pages; no client-side auth/401 handling (silent empty screens) | `pages/404.js`, `500.js`, `utils/api.js` | FIXED |
| M16 | Medium | Frontend | Every referenced PWA/social asset 404'd (`favicon.ico`, `og-image.png`, `icon-192/512`, `apple-touch-icon`) | `frontend/public/` | FIXED (generated) |
| M17 | Medium | Frontend | Hardcoded `http://localhost:3000` rewrite target | `frontend/next.config.js` | FIXED (env-driven) |
| M18 | Medium | Deploy | nginx had no rate limit and no CSP | `deploy/plankton-nginx.conf:7,37,60-61` | FIXED |
| M19 | Medium | UX | Install menu offered `qwen3.6:27b` (not in catalog) and preset `f)` silently dropped a model | `worker-app/install-*.sh` | FIXED |
| M20 | Medium | Docs | `docs/api.md` documented endpoints that no longer exist and omitted auth rules | `docs/api.md` | FIXED (rewritten) |
| M21 | Medium | Money | IPN webhook gated on `result.status !== 'finished'` while `processIPN` normalizes success to `'completed'` → **every finished IPN silently `ignored`** (deposits + Plus) since v3.18.0 | `backend/src/routes/payments.js:86` | FIXED (3.27.0 — gate on `result.success` only; live-verified: `ok` → replay `deduped`) |
| L1 | Low | Security | Reset token stored in plaintext in DB | `backend/src/routes/auth.js:289` | OPEN |
| L2 | Low | Security | JWT lives 7 days and is stored in `localStorage` (XSS-exfiltratable) | `backend/src/routes/auth.js:48,87` | OPEN |
| L3 | Low | Security | No server-side session invalidation: logout is client-side only | `backend/src/routes/auth.js` | OPEN |
| L4 | Low | Money | Payout + ledger insert are not one transaction (payout can succeed, ledger row fail) | `backend/src/routes/payments.js:226-250` | OPEN |
| L5 | Low | Security | `/api/auth/google`, `/set-password`, `/change-password` have no dedicated rate limit | `backend/src/server.js:111-126` | OPEN |
| L6 | Low | Privacy | `/api/leaderboard/users` exposes internal user ids | `backend/src/routes/leaderboard.js:24` | OPEN |
| L7 | Low | Docs | `docs/architecture.md` / `tokenomics.md` describe burning + PLANKTON token flows that the code never implements | `docs/*` | OPEN |

---

## 3. Critical & high findings in detail

### C1 — Daily free allowance reset on every request (money)

`pg` returns `DATE` (OID 1082) as a JS `Date` pinned to **local** midnight. The comparison `last_reset_date !== today` therefore never matched, and the billing block reset `tokens_used_today` to 0 on every request — 1000 free tokens *per request*.

**Fix (two independent guards):**
- `backend/src/database/pool.js:11` — `types.setTypeParser(1082, v => v)` so the column comes back as the exact `'YYYY-MM-DD'` string.
- `backend/src/routes/chat.js:97-111` — `todayKey()` and `toDateKey()` now use the **same** calendar on both sides (local components). Previously `toDateKey` used `toISOString()` while the stored value was local midnight: in any UTC+n timezone that shifts the date back one day and reintroduces the bug.
- Regression test: `backend/tests/models.pricing.test.js` → *"normalises Date values pinned to LOCAL midnight without shifting the day"*.

### C2 — Reset token leaked (account takeover)

`POST /api/auth/forgot-password` returned `{ reset_token }` to the caller and logged it. Anyone could request a reset for a victim's email and read the token from the response.

**Fix:** `backend/src/routes/auth.js`:
- Token is delivered by email only (Resend via `backend/src/services/email.js`).
- When `RESEND_API_KEY` is absent in production the endpoint returns **503 before any account lookup** — so the status code cannot enumerate accounts, and the caller never believes an email was sent (`auth.js:278-286`).
- The dev-only escape hatch (`reset_token` in the response) runs only when `NODE_ENV === 'development'`.
- New page `frontend/pages/reset-password.js` consumes `?token=`; `Navbar` no longer reads `data.reset_token`.

### C3 — Response cache could leak across users

`cacheMiddleware` keys only on `req.originalUrl`. Any authenticated endpoint mounted behind it would cache one user's body and replay it to others.

**Fix:** `backend/src/cache.js:39-46` — requests carrying `Authorization` **or** a resolved `req.user`, and every non-GET, bypass the cache entirely (`isCacheableRequest`, unit-tested). `/api/workers` (which returns `worker_token`) is no longer mounted behind the cache at all.

### C4 — Payment webhook trust

IPN had no signature verification in the shipped path, no idempotency (replayed webhooks re-credited), and the credit amount was taken from the payload rather than the stored order.

**Fix:**
- `services/nowpayments.js:73-95` — HMAC-SHA512 over the key-sorted payload with `timingSafeEqual`, **fail closed** when `NOWPAYMENTS_IPN_SECRET` is unset.
- `routes/payments.js` — deposit rows now store `order_id` (new additive column + indexes in `migrate.js`); the webhook **claims** the pending row inside a transaction (`UPDATE … WHERE status='pending' AND (order_id=$3 OR processor_id=$3 …) RETURNING`), credits the **stored** amount, and answers `deduped: true` on replay.
- Tests: `backend/tests/ipn.test.js` (correct sig, wrong secret, tampered amount, missing/short signature).

### H1/H2 — Admin role and JWT hardening

- `validate.js:20` restricts `role` to `user|worker` (no `admin`).
- `auth.js` register forces `role='user'` and uses `ON CONFLICT (email)` to close the registration race.
- `middleware/auth.js` — `jwt.verify(..., { algorithms: ['HS256'] })`, and `requireAdmin` re-reads the role from Postgres with a 60s cache, **failing closed** if the DB is unreachable.
- Tests: `backend/tests/auth.middleware.test.js` (wrong secret, hand-crafted `alg:none` JWT, forged admin claim).

### H9/H10 — Production surface area

- `DEVELOP.md` no longer contains the server IP or `ssh root@…` (moved to the private vault). **Treat the old value as exposed and rotate SSH access accordingly.**
- `deploy/plankton-worker.service` now runs `src/cli.js` (headless) instead of the Electron `main.js`, drops the hardcoded `WALLET_ADDRESS`, adds `TimeoutStopSec` and systemd hardening (`NoNewPrivileges`, `ProtectSystem=full`, `RestrictAddressFamilies`, …).

---

## 4. Money-flow invariants (chat billing)

Since v3.24.0 billing is a single transaction with row locks — the only place in the codebase that mutates a balance:

0. (v3.27.0, extended v3.28.0) **Coverage pre-flight before dispatch:** free allowance remaining (daily tokens for the resolved subject — `user_id` or guest IP) OR worker credit remaining OR token-pot balance > 0 OR wallet balance > 0? If *nothing* covers the next message → `402 upgrade_required` (`free`/`plans`/`token_bundle`/`signed_in` in the body). The pre-flight query itself **fails open** — a DB error never blocks chat.
1. (v3.27.0) `chargeFreeTokens()` runs first: row-locked upsert of `daily_tokens` / `daily_tokens_guest` (UTC-day rollover in the same statement, epsilon-rounded) — when the daily token cap (2M Free, 10M/30M/80M on Plus/Pro/Max) covers the usage, the task is `free`: **no wallet debit and no worker revenue share**.
2. (v3.25.0) `chargeWorkerCredit()`: if the user has an `online`/`busy` worker, an `INSERT … ON CONFLICT` upsert row-locks `worker_daily_credit` (UTC-day rollover in the same statement) and, when the $1/day allowance covers `cost`, marks the task `free_worker` — **no wallet debit and no worker revenue share**.
3. (v3.28.0) `chargeTokenPot()`: an all-or-nothing `UPDATE user_token_balances … WHERE tokens >= $n RETURNING tokens` inside the same transaction (the re-check under the row lock makes parallel messages race-safe) — when the prepaid pot covers the whole message, the task is `tokens` (+ `token_balance_remaining`): **no wallet debit**; the serving worker is credited `cost × 0.9` from bundle revenue (`source = 'tokens'`).
4. Otherwise lock `user_coin_balances` with `FOR UPDATE` and debit — `min(cost, balance)`, so a dust balance is drained to exactly $0 instead of parking forever; a `paid` result carries `notice: "upgrade_recommended"`.
5. Credit the worker **only if it actually served the task** (`workerId && servedByWorker`), at a flat 90% (`WORKER_REVENUE_SHARE`) on both paid legs (wallet debit and pot spend alike) — with `source` (`wallet`/`tokens`) and the payer's `plan_type` recorded on `worker_coin_earnings` (the 5-way profile breakdown). Free legs earn the worker nothing.
6. Nothing covers (a race after pre-flight — a concurrent request spent the last unit) → no debit happens and the already-generated reply is served as `payment_status: "free"`; generation is never wasted.
7. Guests (no JWT) enter the same chain with `daily_tokens_guest` (keyed by `req.ip`); no credit, no pot and no wallet, so an exhausted guest hits the same `402` wall.

Invariants asserted by tests: pricing = `tokens × outputPrice / 1e6`, revenue share `0.9`, catalog/default-model consistency (`tests/models.pricing.test.js`); credit allowance/rollover/charge-refuse (`tests/worker.credit.test.js`); allowance rollover/exhaustion/guest-key/wall (`tests/free.allowance.test.js`); plan catalog/caps/activation, token-pot SQL and order-id routing (`tests/plans.test.js`).

---

## 5. What changed outside the backend

- **Frontend:** shared `utils/api.js` (`apiFetch` + `useAuth`) replaces render-time redirects and gives every page identical 401 handling; admin page gated on `role` with a proper access-denied state; `Number(x).toFixed()` guards; `pages/404.js`, `pages/500.js`; internal navigation via `next/link`; env-driven API rewrite; generated `favicon.ico/svg`, `apple-touch-icon.png`, `icon-192/512.png`, `og-image.png` (reproducible: `python3 scripts/generate_assets.py`).
- **Deploy:** nginx gains `limit_req`/`limit_conn` in front of the API and a CSP (Google Sign-In is the only third party allowed to execute/frame); systemd unit fixed as above.
- **Tests/CI:** `backend/tests/` (43 assertions, no DB/Redis required) + `.github/workflows/ci.yml` (syntax check + jest + `next build` + `next lint` + `bash -n` on install scripts).
- **Docs:** `docs/api.md` rewritten against the real route table; this report added.

---

## 6. Verification performed

| Check | Command | Result |
|-------|---------|--------|
| Backend syntax | `node --check` on every `backend/src/**/*.js` | pass |
| Backend boot | `node src/server.js` with no DB | boots; `/health` → **503 degraded**, `/health/live` → **200**, `/api/token/balance` → **401**, `/api/models` → 200 (degrades gracefully) |
| Unit tests | `cd backend && npm test` | **43/43 pass** (6 suites) |
| Frontend build | `cd frontend && npm run build` | pass (12 routes) |
| Frontend lint | `cd frontend && npm run lint` | pass (warnings only, no errors) |
| Install scripts | `bash -n worker-app/*.sh` | pass |
| Assets | `file frontend/public/*` | valid PNG/ICO/SVG, correct dimensions |

---

## 7. Open risks & recommended next steps

| # | Risk | Recommendation | Effort |
|---|------|----------------|--------|
| 1 | **`RESEND_API_KEY` / `EMAIL_FROM` not set** → password reset returns 503 in production | Set them in the production env (already documented in `backend/.env.example`), then verify a reset end-to-end | S |
| 2 | Reset token stored in plaintext (L1) | Store `sha256(token)` only; compare hashes | S |
| 3 | 7-day JWT in `localStorage` (L2/L3) | Short-lived access token + server-side revocation list (Redis) wired into `authenticate` | M |
| 4 | Payout vs ledger not atomic (L4) | Wrap debit+payout-insert in one transaction, or write the ledger row first with `status='pending'` and update it | M |
| 5 | Missing rate limits on secondary auth routes (L5) | Reuse `authLimiter` for `/google`, `/set-password`, `/change-password` | S |
| 6 | ~~Guest chat is free by design (product decision)~~ | **Resolved in v3.27.0:** guests now draw on a per-IP daily token allowance (2M/UTC-day, `daily_tokens_guest`) with the same `402` wall as users when exhausted; 6 req/min/IP + global limiter + nginx `limit_req` remain | — |
| 7 | `plankton-private/` is empty (config/contracts/scripts/secrets placeholders) | Decide whether this repo stays public-only; secrets must never land here. `.env` is git-ignored | — |
| 8 | Docs describe burning/PLANKTON token flows the code never implements (L7) | Either implement or mark `tokenomics.md`/`architecture.md` as "planned" | S |
| 9 | No DB-backed integration tests | Add a dockerised Postgres job to CI and cover register→login→chat-billing→IPN end-to-end | L |
| 10 | Old server IP in git history (H9) | Rotate SSH keys/limits; consider history rewrite if the repo is ever published | S |

---

## 8. Deployment checklist (production, no downtime)

1. `git pull` on the VPS → `backend/`, `frontend/`.
2. Set `RESEND_API_KEY`, `EMAIL_FROM` in `backend/.env` (only required new vars).
3. `cd backend && node src/database/migrate.js` — additive and idempotent (`coin_deposits.order_id`, lookup indexes, `schema_migrations`). Re-running is safe; exits non-zero on failure.
4. `cd frontend && npm ci && npm run build`.
5. `nginx -t && systemctl reload nginx` — verify `/health` still returns 200 in production (it will return **503 if Postgres is down** — that is intentional; update the monitor to expect 200 only when healthy).
6. `systemctl restart plankton-backend` — SIGTERM now drains HTTP + WS and closes pool/Redis.
7. Worker hosts: `systemctl daemon-reload && systemctl restart plankton-worker` (unit now runs `src/cli.js`).
8. Smoke: `curl -s https://plankton.click/health`, send one chat message as a guest and one as a signed-in user, confirm `payment_status` behaves (`free` + `free_tokens_remaining` below the cap); then force-exhaust a subject (set `tokens_used_today = 2000000`) and confirm `402 upgrade_required` with the Plus card; `GET /api/plans` and `POST /api/plans/plus/purchase` return caps/`invoice_url`.
