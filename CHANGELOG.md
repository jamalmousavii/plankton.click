# Changelog

All notable changes to Plankton are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **`POST /v1/embeddings`** — OpenAI-compatible embeddings (`bge-m3`,
  `embeddinggemma`, `nomic-embed-text`), served by workers and billed on
  input tokens at the catalog input price; listed in `GET /v1/models`.
- **RAG over large chat files** — files over 12,000 chars are chunked,
  embedded with the question, and only the 6 most relevant excerpts reach the
  chat model (falls back to the full text if no embedding worker answers).
- **Worker protocol 3** (`embed` / `embed_result`); `bge-m3` is installed on
  every worker automatically and cannot be removed from the manager menu.

### Changed
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
