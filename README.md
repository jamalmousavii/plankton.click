<p align="center">
  <img src="frontend/public/icon-192.png" width="96" alt="Plankton" />
</p>

<h1 align="center">plankton.</h1>

<p align="center">
  A decentralized LLM network — chat with open models served by a swarm of community GPU <b>workers</b>,<br/>
  or run a worker and earn 90% of every paid reply it serves.
</p>

<p align="center">
  <a href="https://plankton.click">plankton.click</a> ·
  <a href="https://plankton.click/worker">Run a worker</a> ·
  <a href="docs/api.md">API</a> ·
  <a href="CHANGELOG.md">Changelog</a> · <b>v1.0.0</b>
</p>

---

## What is a worker?

A **worker** is any machine (and the person who runs it) that joins the
Plankton ecosystem and takes part in answering user chats. It runs
[Ollama](https://ollama.com) locally, connects to `wss://plankton.click/ws`
with its own token, and receives chat tasks for the models it has pulled.
Workers are paid a flat **90%** of every paid message they serve.

## Links

| Service | URL |
|---------|-----|
| Website + chat | https://plankton.click |
| Worker install guide | https://plankton.click/worker |
| My workers | https://plankton.click/workers |
| API health | https://plankton.click/health |
| Coder API (OpenAI-compatible) | https://plankton.click/v1 |

## Features

- **Worker-only inference** — every reply comes from a community GPU worker, exact model only (no silent substitution). No worker online → `503 WORKER_OFFLINE` waiting state; wrong model → `409 MODEL_UNAVAILABLE` with switch suggestions. Unserved messages are never charged.
- **Multi-model workers** — one worker serves every pulled model, with per-model health and sticky, GPU-weighted routing plus failover.
- **Unlimited workers per account** — each with its own token (`pw_…`); add, rename, rotate token, remove (history kept) from `/workers`.
- **Installers for Ubuntu/Debian, RedHat/Fedora, macOS 13+ and Windows 10/11** — re-running opens a manager menu (add/remove/repair models, token/name, update, restart); matching uninstallers unregister the worker.
- **End-to-end encrypted tasks** between server and worker (key derived from the worker token).
- **Attachments & voice** — images (vision models), PDFs/text files (parsed server-side), ≤60s voice notes.
- **Conversation context** — a sliding window of recent turns rides every dispatch.
- **Payments** — USD wallet via NowPayments (BTC, ETH, BNB, USDT, TRX, DOGE, XRP), USDT-TRC20 withdrawals, daily free allowance, Plus/Pro/Max plans, never-expiring token bundles, organization plans with a shared bucket.
- **Worker free credit** — an online worker earns its owner $1/day of free chat.
- **Coder API** — OpenAI-compatible `/v1` for coding agents (opencode, Continue, Aider…).
- **Embeddings** — `POST /v1/embeddings` (OpenAI shape, `bge-m3` / `embeddinggemma` / `nomic-embed-text`), billed on input tokens; every worker installs `bge-m3` automatically.
- **Chat over large files (RAG)** — a big attached file is split into excerpts, embedded with `bge-m3`, and only the passages most relevant to the question reach the chat model.
- **Support tickets + full admin panel** (users, workers, tasks, tickets, payments, purchases, orgs) with an audit log.
- **33 languages** with browser detection and RTL for FA/AR/HE/UR.
- **Modern UI** — ocean-ink + bioluminescent palette, animated hero, mobile-first chat frame (keyboard-safe on iOS/Android, safe-area aware).
- **Ops** — encrypted nightly DB backups with restore drill, billing reconciliation, graceful shutdown, health/readiness endpoints.

## Quick Install (Worker)

### Ubuntu / Debian

```bash
wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-ubuntu.sh && bash install-ubuntu.sh
```

### RedHat / Fedora / CentOS

```bash
wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-redhat.sh && bash install-redhat.sh
```

### macOS 13+ (Apple Silicon / Intel with AVX2)

```bash
curl -fsSL https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-macos.sh -o install-macos.sh && bash install-macos.sh
```

Requires macOS 13 (Ventura) or newer — Big Sur and older are not supported.

Needs Homebrew. First run: right-click → Open (unsigned build). Re-running opens the Manager menu (add/remove/repair models, token/name, update, restart).

### Windows 10 / 11

```powershell
Invoke-WebRequest -Uri https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-windows.ps1 -OutFile install-windows.ps1
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

The install script automatically sets up:
- Node.js 20
- Ollama
- Selected AI models (13 chat/code/vision models to pick from)
- `bge-m3` (1.2 GB), always installed — it serves embeddings
- Plankton Worker (CLI mode, systemd service)

> **Token prompt:** when the installer asks for your worker token, the input is
> **visible** (what you paste/type shows on screen) with a char-count
> confirmation — if paste seems to "do nothing", you're likely on the old
> script; re-download it. Avoid pasting on shared terminals or recordings
> (a leaked token can be rotated from Profile → Worker Settings).

Requires **~15 GB free disk** (checked before the model download; bypass with
`PLANKTON_SKIP_DISK_CHECK=1`). Every script passes `shellcheck` (enforced in CI).

### Add another worker (same account, unlimited)
Each server-worker gets its **own unique token** (the token IS the worker identity).
1. Profile → Worker Settings → **+ Add Worker** (optional name) → copy its token
2. On the new machine, install with **that token**:
```bash
wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/install-ubuntu.sh && bash install-ubuntu.sh --token pw_... --name my-second-worker
```
3. The new worker appears as its own card (status, model, earnings). Remove any
worker anytime from profile (history is preserved, soft delete).

### Uninstall

```bash
# Ubuntu/Debian
wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/uninstall-ubuntu.sh && bash uninstall-ubuntu.sh

# RedHat/Fedora
wget https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/uninstall-redhat.sh && bash uninstall-redhat.sh

# macOS
curl -fsSL https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/uninstall-macos.sh -o uninstall-macos.sh && bash uninstall-macos.sh
```

```powershell
# Windows
Invoke-WebRequest -Uri https://raw.githubusercontent.com/jamalmousavii/plankton.click/main/worker-app/uninstall-windows.ps1 -OutFile uninstall-windows.ps1
powershell -ExecutionPolicy Bypass -File .\uninstall-windows.ps1
```

Choose to remove worker only or everything (worker + Ollama + models).

## Coder API for AI Agents

OpenAI-compatible endpoints so coding agents (opencode, Continue, Aider…)
use the two coder models on your balance:

1. Settings → create an API key (`sk_...`, shown once).
2. Key needs a token balance, wallet funds, or Plus/Pro/Max — free plan alone gets `402`.
3. Paste into `opencode.json` (with `PLANKTON_API_KEY` exported):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "plankton": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Plankton",
      "options": { "baseURL": "https://plankton.click/v1", "apiKey": "{env:PLANKTON_API_KEY}" },
      "models": {
        "qwen3-coder:30b": { "name": "Qwen3 Coder 30B", "limit": { "context": 262144, "output": 32768 } },
        "qwen2.5-coder:32b": { "name": "Qwen2.5 Coder 32B", "limit": { "context": 32768, "output": 8192 } }
      }
    }
  }
}
```

`GET /v1/models` · `POST /v1/chat/completions` (non-streaming; `stream`/`tools` → honest `400`, phase 2). Full reference: `docs/api.md`.

### Embeddings

```bash
curl https://plankton.click/v1/embeddings \
  -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
  -d '{"model":"bge-m3","input":["first text","second text"]}'
```

Up to 64 inputs (8,192 chars each, 200,000 total) per request. Priced on input
tokens at the model's catalog input price; same ownership gate (`402`) as chat
completions. Embedding models are not offered in the chat UI.

## AI Models & Pricing

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

**Reference:** DeepSeek V4 Flash — $0.14 input / $0.28 output per 1M tokens

## Payments, Free Allowance & Plans

Every message settles in one row-locked transaction, in order:
1. **Daily free allowance** — **2,000,000 tokens per UTC day** for every subject (signed-in users by account, guests by IP); plan tiers raise the cap (up to 80M/day on Max); `payment_status: "free"`, platform-funded
2. **Worker credit** — with a worker `online`/`busy`, the first **$1.00 per UTC day** is free (`payment_status: "free_worker"`); the worker earns nothing from these chats
3. **Token bundle pot** — prepaid tokens ($1 = 1M, never expires) drain all-or-nothing per message (`payment_status: "tokens"`); the worker earns 90% of the message's catalog value, paid from bundle revenue
4. **USD wallet** (deposits via NowPayments) — a worker serving a **paid** reply earns a flat **90%** of the cost, whatever plan the payer is on
5. Race fallback — an already-generated reply is still served as `"free"`

**Wall:** a subject with *zero* coverage (allowance spent + no credit + empty pot + empty wallet) gets `402 upgrade_required` with the plan catalog + bundle offer — checked **before** dispatch; partial coverage never blocks.

**Plans** — bought with crypto via NowPayments, renewal extends from `max(now, expiry)` by 30 days:

| Tier | Price | Tokens/day | Catalog value/day* |
|------|-------|-----------:|-------------------:|
| Free | $0 | 2,000,000 | ≈ $0.32 |
| ⭐ Plus | $4.99/mo | 10,000,000 | ≈ $1.58 |
| 🚀 Pro | $9.99/mo | 30,000,000 | ≈ $4.74 |
| 👑 Max | $19.99/mo | 80,000,000 | ≈ $12.64 |

\* at the default model's catalog output price ($0.158/1M).

**Token bundles** — whole dollars **$1–$500 → 1M tokens per $1**, one-time payment, **never expires**, settled between the daily allowance and the wallet.

**Worker earnings breakdown** — every earning row records its source and the payer's plan; the profile shows 5 buckets: 🎟️ Tokens / 👛 Wallet / ⭐ Plus / 🚀 Pro / 👑 Max (free legs pay workers nothing).

**Organization plans** — a company/leader shares their plan cap as one bucket: admin creates the org, the leader adds registered users by email, everyone drains the shared allowance with per-member usage reporting on `/org`. No member cap; one active org per user.

**Data safety + correctness** — encrypted nightly DB backups (14-day retention, rclone-ready offsite, restore-drill script) with a systemd timer; billing reconciliation for settlement failures (`billing_pending` → retried by maintenance); race-proof orgs (transactions + DB-enforced single active membership); one shared pricing source; purchase double-click guard (client lock + server `409`).

## Project Structure

```
plankton.click/
├── backend/                    # API Server (Node.js/Express)
│   ├── src/
│   │   ├── server.js          # Entry point
│   │   ├── models.js          # AI models + pricing
│   │   ├── database/
│   │   │   ├── pool.js        # PostgreSQL connection
│   │   │   ├── tx.js          # withTransaction helper
│   │   │   └── migrate.js     # DB migration (25 tables + resource columns)
│   │   ├── routes/
│   │   │   ├── auth.js        # Authentication
│   │   │   ├── workers.js      # Worker management
│   │   │   ├── chat.js        # LLM chat + payment chain + coverage wall
│   │   │   ├── payments.js    # USD wallet + NowPayments (deposit/plan/token IPN)
│   │   │   ├── plans.js       # Plan catalog (Plus/Pro/Max) + tier/token-bundle purchase
│   │   │   ├── token.js       # Balance snapshot
│   │   │   ├── models.js      # Model list API
│   │   │   ├── tickets.js     # User support tickets
│   │   │   └── admin.js       # Admin panel API: views + audited actions
│   │   ├── middleware/
│   │   │   └── auth.js        # JWT auth
│   │   └── cache.js           # Redis caching
│   └── package.json
├── frontend/                   # UI (Next.js 14 + Tailwind CSS)
│   ├── pages/
│   │   ├── index.js           # Chat homepage (state hub; UI split into components/chat/)
│   │   ├── profile.js         # Dashboard (balance, plans + token bundle cards, transactions card, earnings breakdown, worker credit, rank)
│   │   ├── workers.js          # Worker management + Quick Install copy + history
│   │   ├── settings.js        # Settings (USD wallet, 33-lang dropdown, password)
│   │   ├── worker.js           # Worker docs: install/connect/delete + GitHub
│   │   ├── leaderboard.js     # Top workers/users
│   │   ├── support.js         # Support tickets: list/new/thread
│   │   └── admin.js           # Admin panel: 8 tabs + management actions
│   ├── components/
│   │   ├── Navbar.js          # Nav (Worker, ⭐ Plans, Leaderboard; 🎫 Support in avatar dropdown + mobile menu, 🛡️ Admin) + auth + lang dropdown
│   │   ├── EarningsBreakdown.js # 5-way worker earnings breakdown (profile, /workers, /worker)
│   │   ├── PlansContent.js    # Pricing cards shared by inline section + modal
│   │   ├── PlansModal.js      # Pricing overlay for /#plans deep links + Navbar
│   │   ├── Footer.js          # Global version footer
│   │   ├── GoogleLogin.js     # Google OAuth
│   │   ├── ErrorBoundary.js   # Error boundary
│   │   ├── LanguageSwitcher.js # 33-lang dropdown with flags
│   │   └── chat/              # Chat UI split (Sidebar, MessageList, Composer, UpgradeWall)
│   ├── hooks/
│   │   └── useApi.js          # Abort-aware fetch hook (leaderboard)
│   ├── i18n/
│   │   ├── translations.js    # Code-split registry (en static + 32 lazy) + LANGUAGES + detectLanguage
│   │   ├── translations/      # One file per language (33 files)
│   │   └── LanguageContext.js  # Provider (browser detect + sessionStorage)
│   └── package.json
├── worker-app/                  # Worker install scripts
└── docs/                       # Documentation
```

## Database Schema (25 Tables)

| Table | Purpose |
|-------|---------|
| users | User accounts (+ `role`, `banned` since) |
| workers | GPU worker registrations (multi-worker: unique `worker_token` per row) |
| tasks | Chat task history |
| transactions | Token transactions |
| staking | Staking records |
| user_balances | PLANKTON token balance |
| deposits | Deposit history |
| api_keys | API key management |
| user_coin_balances | Multi-coin balances |
| coin_deposits | Crypto deposit history |
| coin_withdrawals | Crypto withdrawal history |
| worker_coin_earnings | Worker earnings |
| chat_sessions | Chat session groups |
| daily_tokens | Daily free allowance — signed-in users (2M tokens/UTC-day) |
| worker_daily_credit | Free daily chat credit for worker hosts ($1/UTC-day) |
| daily_tokens_guest | Daily free allowance — guests, keyed by client IP |
| user_plans | Active subscription tiers (plus/pro/max) |
| plan_purchases | Plan/token invoice claims — IPN exactly-once idempotency |
| user_token_balances | Prepaid token pot — $1 = 1M tokens, never expires |
| tickets | Support tickets — subject/category/status |
| ticket_messages | Ticket thread messages, user + admin replies |
| admin_audit_log | Admin action trail — who/action/target/reason/payload |
| orgs | Organization plans — admin-created, leader-owned shared bucket |
| org_members | Active memberships — one ACTIVE org per user (partial unique) |
| schema_migrations | Migration bookkeeping |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, React 18, Tailwind CSS |
| Backend | Node.js 20, Express, PostgreSQL, Redis |
| LLM | Ollama (on workers), 16 models (Llama, Qwen, Gemma, DeepSeek, Phi, GPT-OSS, Mistral, BGE) |
| Auth | Google OAuth 2.0, JWT |
| Payments | NowPayments — USD wallet, 7 coins at checkout, USDT TRC-20 withdraw |
| Server | Ubuntu 24.04, Nginx, Let's Encrypt |
| i18n | 33 languages (browser detect, RTL FA/AR/HE/UR) |

## Development

### Backend

```bash
cd backend
npm install
node src/server.js
# Runs at http://localhost:3000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
# Runs at http://localhost:3001
```

Google Sign-in needs `NEXT_PUBLIC_GOOGLE_CLIENT_ID` at **build** time — copy
`frontend/.env.example` to `frontend/.env.local` (see the file's comment; the same
client id as `GOOGLE_CLIENT_ID` in `backend/.env`).

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/api.md](docs/api.md) | Full API reference (auth, chat billing, workers, payments, health) |
| [docs/AUDIT.md](docs/AUDIT.md) | Security/money audit: findings, fixes, open risks, deploy checklist |
| [docs/architecture.md](docs/architecture.md) | Architecture overview |
| [docs/tokenomics.md](docs/tokenomics.md) | Token model |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## License

MIT License

---

Built with love for the decentralized community
