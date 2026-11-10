# Changelog

All notable changes to Plankton are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [1.2.0] — 2026-11-10

### Added
- **Manage a worker's models from the panel:** Profile → Worker Settings →
  ⚙️ Manage models installs or removes Ollama models on that machine, with
  live download progress (percent and GB), so a new catalog model can be
  added without opening a console. The server sends the worker one narrow
  command over its existing connection (`pull` / `remove` of a model name);
  the worker calls Ollama's HTTP API itself and never runs a shell command.
  Only catalog models, only the worker's owner, one operation at a time. The
  worker checks free disk before downloading, never removes `bge-m3` or its
  last chat model, and starts serving a new model right away (no restart).
  The panel warns when a model needs more RAM than the worker has.
- Owners can turn it off per machine with `"remote_manage": false` in
  config.json (or `PLANKTON_REMOTE_MANAGE=0`).
- Workers installed before 1.2.0 need one update (installer → option 5);
  until then the panel says so.

## [1.1.15] — 2026-11-10

### Fixed
- **Chats still forgot the earlier turns (root cause):** the server sends
  the conversation window to E2E workers encrypted, and `encrypt()` returns
  an object, but the worker only decrypted `history` when it was a string.
  So every E2E worker (all current ones) silently dropped the window and the
  model saw only the newest message ("There is no previous message."),
  for signed-in users and guests alike. Found by testing 1.1.14 against the
  live worker. Workers now decrypt the envelope and advertise protocol 4.
  For older E2E workers the server folds the window into the encrypted
  prompt as text, so context works before they update.
- **Images and voice notes reached E2E workers as ciphertext** (same bug on
  `attachment`). Fixed in the worker (update it to get this).

## [1.1.14] — 2026-11-10

### Fixed
- **Chats forgot the earlier questions:** workers called Ollama without a
  context size, so Ollama used its default (4096 tokens on CPU and small
  GPUs) and silently dropped the oldest messages once a chat outgrew it. The
  server's history budget (6k estimated tokens) was also far over that
  window for Persian and other non-Latin text, where it counted 4 chars per
  token. Workers now ask Ollama for an 8192-token window on every request
  (`OLLAMA_NUM_CTX` / config `num_ctx` to change it) and trim the oldest
  turns to fit. The server estimates non-Latin text at 2 chars/token, sends
  at most ~3.5k tokens, and clips an over-long earlier answer instead of
  dropping the whole turn.

### Added
- **Context for guests:** chats without an account had no session, so every
  message went to the worker alone. The chat page now sends the last
  answered turns with each message; the server validates them and applies
  the same window. Signed-in chats keep using the stored session.

## [1.1.13] — 2026-11-09

### Fixed
- **Windows installer failed to start with "Missing closing '}'":** stock
  Windows PowerShell 5.1 reads the BOM-less script as ANSI, so the UTF-8
  em dash and check marks in it turned into stray quote characters and the
  whole file failed to parse. Both Windows scripts are now pure ASCII.
- The installer also used PowerShell 7-only `||`, and redirected `ollama`
  stderr under `$ErrorActionPreference = "Stop"`, which aborts on 5.1 at the
  first progress line. Native calls now go through `Invoke-Native`, which
  checks the exit code, and model downloads show their progress again.
- The scheduled task now quotes the `cli.js` path, so the worker starts for
  Windows user names that contain spaces. The config ACL grant uses
  `${env:USERNAME}`.
- CI parses the Windows scripts with Windows PowerShell 5.1 instead of
  `pwsh`, which had hidden all of this.

## [1.1.12] — 2026-11-04

### Fixed
- **Site hung blank or loaded very slowly in Chrome:** every page loaded its
  fonts with a render-blocking stylesheet from `fonts.googleapis.com`, which
  is slow or unreachable for many visitors (notably from Iran without a VPN),
  so the browser waited for it before painting anything. Inter and Space
  Grotesk are now self-hosted (`frontend/public/fonts`, latin + latin-ext
  woff2, `font-display: swap`, Inter preloaded, cached for a year); the site
  makes no request to Google until someone clicks “Sign in with Google”.

## [1.1.11] — 2026-11-04

### Added
- **Direct worker endpoint `wss://ws.plankton.click/ws`:** a DNS-only name
  (no Cloudflare proxy) served by the origin's nginx with its own Let's
  Encrypt certificate; only `/ws` and `/health` are exposed there. Workers
  try it first and fall back to `wss://plankton.click/ws` within ~1 s if it
  fails (DNS missing, filtered, TLS error); after a session that worked they
  start again from the direct endpoint. The TLS servername now follows the
  URL's host, the handshake times out after 15 s, and `API_WS_URL` accepts a
  comma-separated list. Workers behind VPNs/networks that cut long-lived
  connections through Cloudflare kept dropping mid-task.

## [1.1.10] — 2026-11-04

### Fixed
- **Long answers failed with "Workers failed to answer (worker: Worker
  disconnected)" on workers behind flaky links:** a worker whose connection
  drops and re-authenticates a few seconds later (NAT/proxy rotation, mobile
  or filtered networks) kept generating and sent the result on its new
  socket, but the server had already rejected the task the moment the old
  socket closed. In-flight tasks are now held for 60 s
  (`WS_RECONNECT_GRACE_MS`) and stay claimed by that worker; the result is
  accepted on the new connection. The dispatch timeout is unchanged.
- **Worker lost a result finished right after reconnecting:** results were
  sent as soon as the socket was open, before `auth_ok`, and the server
  dropped them as "Not authenticated". They are now buffered until auth.
- Server and worker logs include the WebSocket close code and reason.

## [1.1.9] — 2026-11-04

### Fixed
- **Chat showed "Error connecting to server" while a slow worker was still
  answering:** plankton.click is behind Cloudflare, which aborts a request
  whose response has not started within 100 s (HTTP 524); CPU workers and
  large models routinely take longer. `POST /api/chat` and
  `POST /v1/chat/completions` now commit a 200 after ~20 s and send a space
  every 15 s (valid leading JSON whitespace, uncompressed, unbuffered by
  nginx) until the answer is ready. A late failure keeps its real status in
  the body as `http_status`, which the site's `apiFetch` turns back into the
  same error handling as before (waiting bubble, retry, etc.).

## [1.1.8] — 2026-11-04

### Fixed
- **Ubuntu/RHEL install failed at the last step with `sed: unterminated 's'
  command` and `Unit plankton-worker.service is masked`:** the `@ENV_LINES@`
  substitution was missing its replacement, so `sed` failed and `tee` wrote an
  empty unit file, which systemd treats as masked. The unit is now rendered
  to a temp file, checked (ExecStart present, no placeholders left), and only
  then installed; a stale empty unit or `/dev/null` mask is removed first.
- **Re-running after a half-finished install opened the manager menu:** when
  `config.json` exists but there is no usable `plankton-worker` service, the
  installer now resumes the full install and reuses the saved token and name.

## [1.1.7] — 2026-11-03

### Fixed
- **Ubuntu/RHEL installer failed with `curl: (22) ... 403` at "Installing
  Ollama":** ollama.com refuses some countries (e.g. Iran) with HTTP 403,
  while GitHub, the Ollama model registry and its blob CDN stay reachable.
  The installers now fetch Ollama's `install.sh` from the Ollama GitHub repo
  when ollama.com is blocked (same pinned SHA-256), and point its downloads
  at GitHub Releases (identical archives).
- **Re-running the install command executed the old script:** plain
  `wget URL && bash install-ubuntu.sh` saved the new file as
  `install-ubuntu.sh.1` when a previous (failed) run had left
  `install-ubuntu.sh` behind. Every install/uninstall command (README, site
  pages, script headers) now uses `wget -O <file>`.

## [1.1.6] — 2026-11-03

### Fixed
- **Ubuntu/RHEL installer quit at "Installing Ollama":** Ollama's
  `install.sh` now ships `.tar.zst` archives and aborts when `zstd` is
  missing (it is not on minimal Ubuntu/RHEL images). The installers now
  install `zstd` with the build tools and again right before Ollama.
- **Installers exited silently when a step failed:** under `set -e` the bare
  `wait` in `run_with_spinner` killed the script before the failing step's
  log was printed, so the window just closed. The step's error and the last
  20 log lines are now shown (Ubuntu, RHEL and macOS).

## [1.1.5] — 2026-11-02

### Changed
- **`/health` no longer exposes worker capacity publicly:** `online_workers`
  (and the new `chat: ok | no_workers` field) are returned only when the
  request carries an admin's Bearer JWT. The public `status` now reflects only
  the API itself (Postgres): `ok`, or `degraded` + HTTP 503 when the database
  is down. The handler moved to `backend/src/routes/health.js` with tests.

## [1.1.4] — 2026-11-02

### Fixed
- **Windows worker never started:** the installer wrote `config.json` with
  `Set-Content -Encoding utf8`, which on Windows PowerShell 5.1 adds a BOM
  that Node's `JSON.parse` rejects (the worker exited with "no worker_token").
  Config is now written as UTF-8 without BOM, and the worker also strips a BOM
  left by older installs.
- **Updating a worker never added embeddings:** the manager menu's *Update*
  (all four installers) now pulls `bge-m3` and adds it to the served models,
  so workers installed before 1.1.0 start answering `/v1/embeddings` and RAG.

### Changed
- Installers set up **Node.js 22 LTS** (Node 20 is end-of-life): NodeSource
  `setup_22.x` with refreshed SHA-256 pins on Ubuntu/Debian and
  RedHat/Fedora, `node@22` on macOS; Node < 20 is upgraded.

## [1.1.3] — 2026-11-01

### Changed
- **Homepage first.** Opening the site or signing in now lands on the
  homepage instead of jumping into the latest chat; the chat opens when you
  send a message or pick one of your **recent chats** (shown under the input).
- **The logo always goes home**, even mid-chat or from another page.
- A refresh in the middle of a chat reopens that chat (per tab).

## [1.1.2] — 2026-11-01

### Changed
- **New chat keeps you in the chat.** For signed-in users, New chat no longer
  jumps back to the homepage hero (which hid the history sidebar until the
  first message): the chat layout and sidebar stay, and the empty chat shows
  a small welcome. The hero is now only for guests and users without a chat.

## [1.1.1] — 2026-11-01

### Changed
- Homepage: the plan cards are no longer shown inline under the chat box —
  they crowded the hero and pushed the footer out of the fixed chat frame.
  Plans still open from the Navbar **⭐ Plans** link and `/#plans` (modal).

## [1.1.0] — 2026-11-01

### Added
- **Teams** (replace organizations): a team is a shared account with its
  **own plan and token pot**. Members pay from the team's daily plan
  allowance, then its tokens, then their personal coverage; owners can cap
  each member per day. Anyone can create a team; admins give teams plans and
  tokens from the new **Teams** tab. Workers earn from team money like from
  personal money. `/org` → `/team`, `/api/orgs` → `/api/teams`; the schema is
  renamed in place (`orgs` → `teams`, `org_members` → `team_members`).
- **Admin panel upgrades:** user search (email / name / `#id`) and a type
  filter (workers = owners of an active worker / plain users / admins /
  banned); per-user usage at a glance (allowance burned today, tokens /
  spend / messages over 30 days) plus a 30-day usage view by day and by model;
  **plan change** to any tier or back to Free for a chosen number of days
  (replaces active plans, so downgrades work — grants alone never could);
  worker list with search, status filter and earnings split by source (plan /
  wallet / bundle), all-time and 30 days, with totals.
- **`POST /v1/embeddings`** — OpenAI-compatible embeddings (`bge-m3`,
  `embeddinggemma`, `nomic-embed-text`), served by workers and billed on
  input tokens at the catalog input price; listed in `GET /v1/models`.
- **RAG over large chat files** — files over 12,000 chars are chunked,
  embedded with the question, and only the 6 most relevant excerpts reach the
  chat model (falls back to the full text if no embedding worker answers).
- **Worker protocol 3** (`embed` / `embed_result`); `bge-m3` is installed on
  every worker automatically and cannot be removed from the manager menu.

### Removed
- **Public leaderboard** (`/leaderboard`, `GET /api/leaderboard/workers`
  and `/users`, the `useApi` hook it used): it exposed every worker's
  earnings and gave regular users nothing. `/leaderboard` redirects home; the
  authenticated `GET /api/leaderboard/mine` (worker rank + earnings breakdown
  on the profile) stays. Admins get the same view in the panel: workers sorted
  by earnings, users sortable by 30-day usage or spend.

### Changed
- **Model-weighted token usage.** One token of a model now burns
  `model price ÷ llama3.1:8b price` allowance tokens (`token_weight` in
  `GET /api/models`, shown as `×N` in the chat picker): llama3.2:3b ×0.8 …
  llama3.3:70b ×10, deepseek-r1:70b ×11.2, embeddings ×0.2–0.32, each model
  distinct inside its category. Applies to the Free/plan daily allowance, the
  token pot and the plan revenue share. `gemma4:12b` output price 0.08 → 0.09
  so it no longer ties with `qwen3-vl:8b`.
- **Workers now earn from subscriptions.** Previously a plan's price went
  entirely to the platform and plan-covered messages paid workers nothing.
  Now every token a worker serves to a Plus/Pro/Max subscriber earns 90% of
  `price ÷ 30 ÷ daily cap` (Plus: $0.00897 per 1M tokens), credited per
  message with source `plan` (`payment_status: "plan"`). Free tier still pays
  nothing. The Plus/Pro/Max earnings buckets now mean subscription revenue;
  wallet payments count as Wallet whatever the payer's tier.
- **New, market-beating pricing.** Every model is now priced at or below the
  cheapest public hosted rate (DeepInfra / OpenRouter / Groq, Oct 2026) and
  scales with model size — e.g. `llama3.1:8b` $0.015 / $0.025 per 1M
  (was $0.079 / $0.158), `llama3.3:70b` $0.08 / $0.25, `bge-m3` $0.008.
- **Cheaper plans:** Plus $2.99, Pro $5.99, Max $11.99 per month (were
  $4.99 / $9.99 / $19.99), same daily caps — below ChatGPT Go ($8) and
  Gemini's entry tier ($4.99).
- **Token bundles fixed:** $1 now buys 40M default-model tokens and the pot
  drains by catalog cost (a 70B token costs 10 pot tokens), so $1 of bundle is
  worth exactly $1 of usage. The old flat $1 = 1M was ~6x worse than the wallet.
- Embedding models are no longer installer menu choices (they were never
  useful alone) and no longer appear in the chat model picker; chatting with
  one returns `400 MODEL_NOT_CHAT`.

## [1.0.0] — 2026-10-27

First release under the **Plankton** name at **https://plankton.click**.
The codebase continues the former Krelz Network (last release 3.45.0, its full
history is in `git log`); the version line restarts at 1.0.0.

### Changed — rebrand and terminology
- **Krelz Network → Plankton**, domain **krelz.xyz → plankton.click**, repo
  **jamalmousavii/plankton.click**. Every URL, service name, env var
  (`PLANKTON_*`), systemd/launchd unit (`plankton-worker`,
  `click.plankton.worker`), install dir (`~/plankton-worker`) and doc updated.
- **"Miner" is now "Worker"** everywhere: the people and machines that join the
  network and answer user chats. Code (`routes/workers.js`,
  `services/workerCredit.js`, `worker-app/`), API (`/api/workers/*`,
  `worker_token`, `worker_id`, `WORKER_OFFLINE`, `free_worker`), pages
  (`/worker`, `/workers`; old `/miner`, `/miners` URLs 308-redirect), and all
  33 locales.
- New worker tokens use the `pw_` prefix. Legacy `kz_` tokens keep working
  (server, worker app and installers accept both). Already-installed pre-1.0
  workers stay compatible: the server accepts their old wire field names
  (`backend/src/legacy.js`) and derives their e2e key with the original salt.

### Added
- **Database rename migration**: `migrate.js` renames the pre-1.0 schema in
  place (`miners` → `workers`, `miner_coin_earnings` → `worker_coin_earnings`,
  `miner_daily_credit` → `worker_daily_credit`, `*_miner_*` columns, indexes
  and sequences; role/ticket-category/audit values). Guarded and idempotent:
  a fresh database or a re-run is a no-op, and no rows are lost.
- **Capability protocol**: workers advertise `protocol: 2` at auth. Media and
  conversation-history routing now keys off it instead of the app version, so
  the version reset does not silently disable those features. Pre-1.0
  binaries keep the old semver gate.
- **New visual identity**: ocean-ink and bioluminescent-lagoon palette,
  Space Grotesk display type, the Plankton cell mark (logo, favicon, PWA icons,
  OG image), animated "plankton field" hero, glass navbar, and a new footer.
  Motion respects `prefers-reduced-motion`.
- Regression suite `backend/tests/release.1_0_0.test.js`.

### Fixed
- Deleting a chat session that contained a paid message failed with a 500
  (FK from earnings). Sessions are now deleted with their content wiped and
  the money trail kept, in one transaction.
- Failed tasks (e.g. "No workers online") reappeared in session history as
  assistant replies; history now only shows completed answers.
- WS heartbeat trusted worker input: a worker could set its own status to
  `removed` or any string, and an out-of-range usage value rolled back the
  whole heartbeat. Status is whitelisted, usage clamped to 0–100, and the model
  name bounded.
- The `authenticate` middleware turned any exception thrown further down the
  chain into a misleading `401 Invalid or expired token`.
- Non-string or non-numeric input caused 500s on several worker routes
  (rename, heartbeat, `GET /api/workers/:id`) and the session rename route.
- `npm run dev` for the frontend collided with the backend on port 3000; the
  UI now runs on 3001 in dev and production (matching nginx), and the dev CORS
  allow-list includes it.
- CSP still allowed the retired `:8443` WebSocket origin.
- `worker-app/package-lock.json` was stuck at an old version; it is now part
  of the bump script and the parity test.
- `sitemap.xml` listed pages that do not exist (`/chat`, `/explorer`).
- `tasks.model` defaulted to a model id that is not in the catalog.
- Removed unused cloud-provider and Ollama variables from
  `backend/.env.example`; the backend has been worker-only for a while.

### Upgrade notes
1. Point DNS for `plankton.click` / `www.plankton.click` at the server and
   issue certificates (`deploy/plankton-nginx.conf` expects
   `/etc/letsencrypt/live/plankton.click/`).
2. Back up, then run `node src/database/migrate.js` once. It renames the
   schema in place.
3. Rebuild the frontend (`npm run build`). `NEXT_PUBLIC_*` values are baked in.
4. Existing workers keep their `kz_` tokens but must be reinstalled with the
   new installer to switch to the new domain, paths and service names.
   Uninstall the old `krelz-miner` service first.
