// CLI entrypoint: load env BEFORE ./pool reads DATABASE_URL (server.js does
// this at startup, but running `node src/database/migrate.js` directly did not,
// so production migrations fell back to the local-dev DSN and failed auth).
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const pool = require('./pool');

const migrate = async () => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // === 1.0.0 rename: miner → worker (Plankton relaunch) ===
    // Pre-1.0 databases (Krelz Network) still use the miner_* schema. Rename
    // in place so every row, sequence and FK survives; each step is guarded,
    // so a fresh database or a re-run is a no-op.
    await client.query(`
      DO $$
      DECLARE r RECORD;
      BEGIN
        IF to_regclass('public.miners') IS NOT NULL AND to_regclass('public.workers') IS NULL THEN
          ALTER TABLE miners RENAME TO workers;
        END IF;
        IF to_regclass('public.miner_coin_earnings') IS NOT NULL AND to_regclass('public.worker_coin_earnings') IS NULL THEN
          ALTER TABLE miner_coin_earnings RENAME TO worker_coin_earnings;
        END IF;
        IF to_regclass('public.miner_daily_credit') IS NOT NULL AND to_regclass('public.worker_daily_credit') IS NULL THEN
          ALTER TABLE miner_daily_credit RENAME TO worker_daily_credit;
        END IF;
        FOR r IN
          SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public'
             AND (table_name, column_name) IN (
               ('workers', 'miner_token'), ('users', 'miner_token'),
               ('tasks', 'miner_id'), ('worker_coin_earnings', 'miner_id'))
        LOOP
          EXECUTE format('ALTER TABLE %I RENAME COLUMN %I TO %I',
            r.table_name, r.column_name, replace(r.column_name, 'miner', 'worker'));
        END LOOP;
        FOR r IN
          SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('i', 'S') AND c.relname LIKE '%miner%'
        LOOP
          IF to_regclass('public.' || replace(r.relname, 'miner', 'worker')) IS NULL THEN
            EXECUTE format('ALTER %s %I RENAME TO %I',
              CASE WHEN r.relkind = 'S' THEN 'SEQUENCE' ELSE 'INDEX' END,
              r.relname, replace(r.relname, 'miner', 'worker'));
          END IF;
        END LOOP;
      END $$;
    `);
    // Stored enum-like values that carried the old name.
    if ((await client.query("SELECT to_regclass('public.users') AS t")).rows[0].t) {
      await client.query("UPDATE users SET role = 'worker' WHERE role = 'miner'");
    }
    if ((await client.query("SELECT to_regclass('public.tickets') AS t")).rows[0].t) {
      await client.query("UPDATE tickets SET category = 'worker' WHERE category = 'miner'");
    }
    if ((await client.query("SELECT to_regclass('public.admin_audit_log') AS t")).rows[0].t) {
      await client.query("UPDATE admin_audit_log SET target_type = 'worker' WHERE target_type = 'miner'");
      await client.query("UPDATE admin_audit_log SET action = replace(action, 'miner', 'worker') WHERE action LIKE '%miner%'");
    }
    console.log('✅ 1.0.0: miner → worker schema rename checked');

    // جدول کاربران
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255),
        name VARCHAR(255),
        avatar TEXT,
        google_id VARCHAR(50) UNIQUE,
        wallet_address VARCHAR(42),
        role VARCHAR(20) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ جدول users ایجاد شد');
    
    // جدول ورکرها
    await client.query(`
      CREATE TABLE IF NOT EXISTS workers (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        wallet_address VARCHAR(42) NOT NULL,
        gpu_model VARCHAR(100),
        ram VARCHAR(50),
        cpu VARCHAR(100),
        models JSONB DEFAULT '["llama3.1:8b"]',
        current_model VARCHAR(50) DEFAULT 'llama3.1:8b',
        status VARCHAR(20) DEFAULT 'offline',
        uptime DECIMAL(5,2) DEFAULT 0,
        total_tasks INTEGER DEFAULT 0,
        earnings DECIMAL(20,8) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ جدول workers ایجاد شد');
    
    // جدول درخواست‌ها
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        worker_id INTEGER REFERENCES workers(id),
        prompt TEXT NOT NULL,
        response TEXT,
        model VARCHAR(50) DEFAULT 'llama3.1:8b',
        tokens_used INTEGER DEFAULT 0,
        cost DECIMAL(20,8) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);
    console.log('✅ جدول tasks ایجاد شد');
    
    // جدول تراکنش‌ها
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        from_address VARCHAR(42),
        to_address VARCHAR(42),
        amount DECIMAL(20,8) NOT NULL,
        type VARCHAR(50) NOT NULL,
        tx_hash VARCHAR(66),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ جدول transactions ایجاد شد');
    
    // جدول استیکینگ
    await client.query(`
      CREATE TABLE IF NOT EXISTS staking (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        amount DECIMAL(20,8) NOT NULL,
        reward DECIMAL(20,8) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ جدول staking ایجاد شد');
    
    // جدول موجودی کاربران
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_balances (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        available DECIMAL(20,8) DEFAULT 0,
        total_earned DECIMAL(20,8) DEFAULT 0,
        total_spent DECIMAL(20,8) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ جدول user_balances ایجاد شد');
    
    // جدول واریزی‌ها
    await client.query(`
      CREATE TABLE IF NOT EXISTS deposits (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        amount DECIMAL(20,8) NOT NULL,
        tx_hash VARCHAR(66),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ جدول deposits ایجاد شد');
    
    // اضافه کردن ستون description به transactions
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS description TEXT;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    console.log('✅ ستون description اضافه شد');
    
    // Indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_workers_wallet ON workers(wallet_address)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tasks_worker_id ON tasks(worker_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_staking_user ON staking(user_id, status)');
    console.log('✅ Indexes created');
    
    // API Keys table
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        name VARCHAR(100) NOT NULL,
        key_hash VARCHAR(64) NOT NULL,
        key_prefix VARCHAR(12) NOT NULL,
        rate_limit INTEGER DEFAULT 100,
        active BOOLEAN DEFAULT true,
        last_used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ جدول api_keys ایجاد شد');
    
    // Admin user
    await client.query(`
      DO $$ BEGIN
        -- Seed a placeholder admin only on an empty install: a database that
        -- already has an admin must not grow a second one (the 1.0.0 domain
        -- change otherwise inserted a fresh admin@plankton.click row).
        IF NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin') THEN
          INSERT INTO users (email, name, role) VALUES ('admin@plankton.click', 'Admin', 'admin')
          ON CONFLICT (email) DO NOTHING;
        END IF;
      EXCEPTION WHEN OTHERS THEN null;
      END $$;
    `);
    console.log('✅ Admin user created');
    
    // === Multi-Coin Payment Tables ===
    
    // User coin balances
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_coin_balances (
        user_id INTEGER REFERENCES users(id),
        coin VARCHAR(10) NOT NULL,
        chain VARCHAR(20) NOT NULL,
        available DECIMAL(20,8) DEFAULT 0,
        total_earned DECIMAL(20,8) DEFAULT 0,
        total_spent DECIMAL(20,8) DEFAULT 0,
        PRIMARY KEY (user_id, coin)
      )
    `);
    console.log('✅ جدول user_coin_balances ایجاد شد');
    
    // Coin deposits
    await client.query(`
      CREATE TABLE IF NOT EXISTS coin_deposits (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        coin VARCHAR(10) NOT NULL,
        amount DECIMAL(20,8) NOT NULL,
        tx_hash VARCHAR(100),
        processor_id VARCHAR(100),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ جدول coin_deposits ایجاد شد');
    
    // Coin withdrawals
    await client.query(`
      CREATE TABLE IF NOT EXISTS coin_withdrawals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        coin VARCHAR(10) NOT NULL,
        amount DECIMAL(20,8) NOT NULL,
        to_address VARCHAR(100) NOT NULL,
        tx_hash VARCHAR(100),
        fee DECIMAL(20,8) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ جدول coin_withdrawals ایجاد شد');

    // USD wallet migration: ensure USD rows exist + fold legacy multi-coin into USD once
    try {
      await client.query(`
        INSERT INTO user_coin_balances (user_id, coin, chain, available, total_earned, total_spent)
        SELECT user_id, 'USD', 'usd', 0, 0, 0
        FROM user_coin_balances
        WHERE coin <> 'USD'
        ON CONFLICT (user_id, coin) DO NOTHING
      `);
      // One-time-ish fold: add non-USD balances into USD (fixed approx rates for migration)
      await client.query(`
        UPDATE user_coin_balances u SET
          available = u.available + COALESCE(x.usd, 0),
          total_earned = u.total_earned + COALESCE(x.usd, 0)
        FROM (
          SELECT user_id, SUM(
            available * CASE coin
              WHEN 'USDT' THEN 1
              WHEN 'BTC' THEN 60000
              WHEN 'ETH' THEN 3000
              WHEN 'BNB' THEN 600
              WHEN 'TRX' THEN 0.12
              WHEN 'DOGE' THEN 0.15
              WHEN 'XRP' THEN 0.5
              ELSE 0
            END
          ) AS usd
          FROM user_coin_balances
          WHERE coin <> 'USD' AND coin <> 'PLANKTON'
          GROUP BY user_id
        ) x
        WHERE u.user_id = x.user_id AND u.coin = 'USD'
      `);
      // Zero out legacy rows after fold (keep history columns)
      await client.query(`
        UPDATE user_coin_balances SET available = 0
        WHERE coin IN ('BTC','ETH','BNB','USDT','TRX','DOGE','XRP')
      `);
      console.log('✅ USD wallet migration completed');
    } catch (migErr) {
      console.warn('⚠️ USD migration note:', migErr.message);
    }

    
    // Worker coin earnings
    await client.query(`
      CREATE TABLE IF NOT EXISTS worker_coin_earnings (
        id SERIAL PRIMARY KEY,
        worker_id INTEGER REFERENCES workers(id),
        coin VARCHAR(10) NOT NULL,
        amount DECIMAL(20,8) NOT NULL,
        task_id INTEGER REFERENCES tasks(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ جدول worker_coin_earnings ایجاد شد');
    
    // Multi-coin indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_coin_deposits_user ON coin_deposits(user_id, coin)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_coin_deposits_status ON coin_deposits(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_coin_withdrawals_user ON coin_withdrawals(user_id, coin)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_coin_withdrawals_status ON coin_withdrawals(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_worker_coin_earnings_worker ON worker_coin_earnings(worker_id, coin)');
    console.log('✅ Multi-coin indexes created');
    
    // === Chat Sessions ===
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        subject VARCHAR(255) DEFAULT 'New Chat',
        model VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ جدول chat_sessions ایجاد شد');

    // Add session_id to tasks (if not exists)
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES chat_sessions(id);
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    console.log('✅ ستون session_id به tasks اضافه شد');

    // Chat session indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id)');
    console.log('✅ Chat session indexes created');

    // === Attachments (v3.20.0) ===
    // tasks.media holds the JSONB copy of what the user attached (image/audio
    // include their base64 so history can re-render thumbnails; files store
    // only metadata because their text lives in tasks.prompt).
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS media JSONB;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    // tasks.prepared_prompt: the prompt after attachment preparation (file text
    // prepended). NULL means "use prompt as-is". Needed because task_request
    // (polling mode) only sees the DB row and must reconstruct the exact
    // prompt that dispatchTask would have sent.
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS prepared_prompt TEXT;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    // workers.app_version: what the worker advertised at auth. Media dispatch
    // (images/audio) only targets workers >= 3.20.0 which understand the
    // `attachment` field on task messages.
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workers ADD COLUMN IF NOT EXISTS app_version VARCHAR(32);
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    console.log('✅ Column tasks.media + workers.app_version added');
    // tasks.history (v3.41.0): snapshot of the conversation window sent with
    // the dispatch ([{role, content}...], capped). NULL/empty = single prompt.
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS history JSONB;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    console.log('✅ Column tasks.history added');

    // === Worker history (v3.22.0) ===
    // workers.last_seen: last time the worker actually talked to us (auth /
    // heartbeat / resource report). NOT updated_at — that also moves on
    // rename/soft-delete. The dashboard uses COALESCE(last_seen, created_at)
    // to archive workers offline for > 10 days into the history section.
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    // workers.uninstalled_at: when the worker was removed (dashboard 🗑️ or the
    // uninstall script calling POST /api/workers/unregister).
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workers ADD COLUMN IF NOT EXISTS uninstalled_at TIMESTAMP;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    // Backfill: existing rows have no last_seen — treat last known contact as
    // updated_at so the 10-day archive rule starts from real data.
    await client.query(
      'UPDATE workers SET last_seen = updated_at WHERE last_seen IS NULL AND updated_at IS NOT NULL'
    );
    console.log('✅ Columns workers.last_seen + workers.uninstalled_at added');

    // === Daily Free Tokens ===
    // Legacy table (feature removed in v3.24.0), reactivated in v3.27.0 by
    // freeAllowance.js: signed-in users spend their daily free allowance
    // (2M/day Free, 10M/day Plus) here. UTC-day reset is handled per-row.
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_tokens (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        tokens_used_today DECIMAL(20,8) DEFAULT 0,
        last_reset_date DATE DEFAULT CURRENT_DATE
      )
    `);
    console.log('✅ جدول daily_tokens ایجاد شد');

    await client.query('CREATE INDEX IF NOT EXISTS idx_daily_tokens_user ON daily_tokens(user_id)');
    console.log('✅ Daily tokens index created');

    // === Worker free chat credit (v3.25.0) ===
    // Signed-in users with an online/busy worker get a USD allowance per UTC
    // day. Spent only inside the chat payment txn: platform-funded, so it
    // never debits the wallet and never credits a worker (no revenue share).
    await client.query(`
      CREATE TABLE IF NOT EXISTS worker_daily_credit (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        usd_used_today DECIMAL(20,8) DEFAULT 0,
        last_reset_date DATE
      )
    `);
    console.log('✅ جدول worker_daily_credit ایجاد شد');

    // === Daily free allowance — guests (v3.27.0) ===
    // Guests have no users row, so their 2M/day free allowance is tracked by
    // client IP (req.ip behind nginx; trust proxy is set in server.js).
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_tokens_guest (
        guest_key TEXT PRIMARY KEY,
        tokens_used_today DECIMAL(20,8) DEFAULT 0,
        last_reset_date DATE DEFAULT CURRENT_DATE
      )
    `);
    console.log('✅ جدول daily_tokens_guest ایجاد شد');

    // === Plus subscription (v3.27.0) ===
    // One active row per user; an expired row simply stops matching
    // (expires_at > now()) and the user falls back to the Free cap.
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_plans (
        user_id INTEGER NOT NULL REFERENCES users(id),
        plan_type VARCHAR(32) NOT NULL DEFAULT 'plus',
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        PRIMARY KEY (user_id, plan_type)
      )
    `);
    console.log('✅ جدول user_plans ایجاد شد');

    // === Plus purchases — IPN idempotency (v3.27.0) ===
    // Mirrors coin_deposits: a replayed 'finished' IPN can only claim a
    // pending row once, so a plan can never be extended twice.
    await client.query(`
      CREATE TABLE IF NOT EXISTS plan_purchases (
        order_id VARCHAR(128) PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        invoice_id VARCHAR(64),
        amount DECIMAL(20,8) NOT NULL,
        tx_hash VARCHAR(256),
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_plan_purchases_user ON plan_purchases(user_id)');
    console.log('✅ جدول plan_purchases ایجاد شد');

    // === Token bundles (v3.28.0): prepaid, non-expiring token pot ===
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_token_balances (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        tokens BIGINT NOT NULL DEFAULT 0,
        total_purchased BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ جدول user_token_balances ایجاد شد');

    // Which tier an order buys (plus/pro/max) or that it is a token bundle
    // ('tokens'); bundles also record the quoted token amount.
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS plan_type VARCHAR(16) NOT NULL DEFAULT 'plus';
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE plan_purchases ADD COLUMN IF NOT EXISTS tokens BIGINT NOT NULL DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    console.log('✅ ستون‌های plan_type/tokens به plan_purchases اضافه شد');

    // Earnings attribution (v3.28.0): which payment source and which plan the
    // paying user was on. The DEFAULT fills every pre-existing row — all of
    // them came from wallet-paid chats (the only paying leg before v3.28.0).
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE worker_coin_earnings ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'wallet';
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE worker_coin_earnings ADD COLUMN IF NOT EXISTS plan_type VARCHAR(16) NOT NULL DEFAULT 'free';
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    await client.query(
      "UPDATE worker_coin_earnings SET source = 'wallet', plan_type = 'free' WHERE source IS NULL OR plan_type IS NULL"
    );
    console.log('✅ ستون‌های source/plan_type به worker_coin_earnings اضافه شد');


    // === Worker Token + Password Reset ===
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS worker_token VARCHAR(128) UNIQUE;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    console.log('✅ ستون worker_token اضافه شد');

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(64);
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    console.log('✅ ستون reset_token اضافه شد');

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expiry TIMESTAMP;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    console.log('✅ ستون reset_token_expiry اضافه شد');

    // B9: forgot-password looks up by reset_token, chat history sorts tasks by
    // (user_id, created_at DESC) — both were sequential scans.
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC)');
    console.log('✅ ایندکس‌های reset_token و tasks(user_id, created_at) ساخته شد');

    await client.query('CREATE INDEX IF NOT EXISTS idx_users_worker_token ON users(worker_token)');
    console.log('✅ Worker token index created');

    // === H3: JWT invalidation version — bumping it kills every outstanding session ===
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    console.log('✅ ستون token_version اضافه شد');

    // === Worker Resource Usage Columns ===
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workers ADD COLUMN IF NOT EXISTS gpu_usage NUMERIC(5,2) DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workers ADD COLUMN IF NOT EXISTS ram_usage NUMERIC(5,2) DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workers ADD COLUMN IF NOT EXISTS cpu_usage NUMERIC(5,2) DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workers ADD COLUMN IF NOT EXISTS disk_usage NUMERIC(5,2) DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    console.log('✅ Resource usage columns added');

    // === Multi-Worker Support (v3.12.0): machine_id + name ===
    // Allows unlimited workers per user (one row per machine).
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workers ADD COLUMN IF NOT EXISTS machine_id VARCHAR(64);
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workers ADD COLUMN IF NOT EXISTS name VARCHAR(100);
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    // Backfill existing workers (no machine_id yet) with a stable generated id
    await client.query(`
      UPDATE workers
      SET machine_id = 'm_' || md5(random()::text || id::text)
      WHERE machine_id IS NULL
    `);
    await client.query(`
      DO $$ BEGIN
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_user_machine ON workers(user_id, machine_id);
      EXCEPTION WHEN duplicate_table THEN null;
      END $$;
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_workers_machine ON workers(machine_id)');
    console.log('✅ Multi-worker columns added (machine_id, name)');

    // === Per-Worker Unique Tokens (v3.13.0): one token per worker row ===
    // Each server-worker gets its own token; token IS the worker identity.
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workers ADD COLUMN IF NOT EXISTS worker_token VARCHAR(128);
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    // Backfill existing rows (no extension needed: md5 yields 32 hex chars)
    await client.query(`
      UPDATE workers
      SET worker_token = 'pw_' || md5(random()::text || id::text || clock_timestamp()::text)
      WHERE worker_token IS NULL
    `);
    await client.query(`
      DO $$ BEGIN
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_token ON workers(worker_token);
      EXCEPTION WHEN duplicate_table THEN null;
      END $$;
    `);
    console.log('✅ Per-worker token column added (worker_token)');

    // === Single-use token display (v3.14.0): hide token after first connect ===
    // token_used_at is set on first successful /setup or WS auth.
    // GET /api/workers/mine hides worker_token when this is set;
    // PUT /api/workers/mine/:id/token rotates the token and clears it.
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE workers ADD COLUMN IF NOT EXISTS token_used_at TIMESTAMP;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    // Existing workers that have connected (gpu info present) are considered used
    await client.query(`
      UPDATE workers SET token_used_at = COALESCE(token_used_at, updated_at)
      WHERE token_used_at IS NULL AND gpu_model IS NOT NULL
    `);
    console.log('✅ Single-use token column added (token_used_at)');

    // ---- v3.18.5: IPN idempotency / deposit reconciliation ----
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE coin_deposits ADD COLUMN IF NOT EXISTS order_id VARCHAR(128);
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_coin_deposits_processor ON coin_deposits(processor_id)'
    );
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_coin_deposits_order ON coin_deposits(order_id) WHERE order_id IS NOT NULL'
    );
    console.log('✅ coin_deposits order_id + lookup indexes added');

    // ---- v3.39.0: support tickets (user → admin thread) ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        subject VARCHAR(200) NOT NULL,
        category VARCHAR(32) NOT NULL DEFAULT 'support',
        status VARCHAR(16) NOT NULL DEFAULT 'open',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_id, id DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, updated_at DESC)');
    console.log('✅ جدول tickets ایجاد شد');

    await client.query(`
      CREATE TABLE IF NOT EXISTS ticket_messages (
        id SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        is_admin BOOLEAN NOT NULL DEFAULT false,
        body TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id, id)');
    console.log('✅ جدول ticket_messages ایجاد شد');

    // ---- v3.39.0: audit trail for every admin mutation (money/role/ban/worker) ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER NOT NULL REFERENCES users(id),
        action VARCHAR(64) NOT NULL,
        target_type VARCHAR(32) NOT NULL,
        target_id INTEGER,
        reason TEXT,
        payload JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC)');
    console.log('✅ جدول admin_audit_log ایجاد شد');

    // ---- v3.39.0: account ban — orthogonal to role (a banned worker keeps role) ----
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT false;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    console.log('✅ ستون banned اضافه شد');

    // ---- v3.44.0: organization plans (shared daily bucket) ----
    // An org shares its LEADER's plan cap: members drain one bucket (the
    // leader's daily_tokens row). Per-member attribution comes from tasks
    // (user_id, tokens_used, cost) — no separate tracking table. One active
    // membership per user (v1). No member cap (locked decision).
    await client.query(`
      CREATE TABLE IF NOT EXISTS orgs (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        leader_user_id INTEGER NOT NULL REFERENCES users(id),
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_members (
        org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        role VARCHAR(16) NOT NULL DEFAULT 'member',
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (org_id, user_id)
      )
    `);
    // NOTE: the plain (user_id) index moved to the v3.45.0 block below, where
    // it is superseded by the partial-unique idx on active memberships.
    await client.query('CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id)');
    console.log('✅ جدول orgs/org_members ایجاد شد');

    // ---- v3.45.0: hot-path indexes + billing reconciliation columns ----
    // /v1 auth looks api_keys up by key_hash on every call — without this it
    // was a sequential scan. Unique because all keys are sha256 sk_ tokens.
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id)');
    // One ACTIVE org membership per user, enforced by the database — the app
    // check alone was check-then-insert (two concurrent adds could both land).
    // Replaces the plain user index: active lookups are the only ones served.
    await client.query('DROP INDEX IF EXISTS idx_org_members_user');
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_members_active_user
         ON org_members(user_id) WHERE status = 'active'`
    );
    // Billing reconciliation (v3.45.0): chat/v1 mark a task 'pending' when it
    // was served but settleMessage threw (nothing charged — it is one
    // rolled-back transaction). The maintenance job retries; after
    // billing_attempts >= 3 the row parks as 'unreconciled' for ops.
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS billing_status VARCHAR(16);
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE tasks ADD COLUMN IF NOT EXISTS billing_attempts INTEGER NOT NULL DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN null;
      END $$;
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_tasks_billing_pending ON tasks(billing_status)
        WHERE billing_status = 'pending'`
    );
    console.log('✅ v3.45.0: ایندکسها و ستونهای billing ایجاد شد');

    // ---- Schema version bookkeeping (baseline marker for future migrations) ----
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(
      `INSERT INTO schema_migrations (version) VALUES ('0001_baseline')
       ON CONFLICT (version) DO NOTHING`
    );

    await client.query('COMMIT');
    console.log('\n✅ تمام جداول ایجاد شد');
    
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ خطا:', err);
    // Fail loudly: a silent exit(0) lets CI/systemd deploy a broken schema.
    process.exitCode = 1;
  } finally {
    client.release();
  }
};

migrate();
