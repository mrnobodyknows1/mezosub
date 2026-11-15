-- FROZEN. MezoSub schema (Postgres 15+ / PGlite). Idempotent: safe to run on every boot.
-- Chain-indexed columns are marked [chain]; they are written ONLY by the indexer / receipt verifier from
-- confirmed logs, never from client input. Amounts are NUMERIC(78,0) token units (wei); times are TIMESTAMPTZ.

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address  TEXT NOT NULL UNIQUE,              -- lowercase 0x…
  email           TEXT,
  notify_email    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce       TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                       -- random 32 bytes hex; cookie holds HMAC-signed id
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address     TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS merchants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- used in metadataURI mezosub:merchant:<id>
  owner_user_id       UUID NOT NULL REFERENCES users(id),
  wallet_address      TEXT NOT NULL,                  -- [chain] owner, lowercase
  onchain_merchant_id NUMERIC(78,0) UNIQUE,           -- [chain] NULL until registration confirmed
  payout_address      TEXT,                           -- [chain]
  chain_status        TEXT NOT NULL DEFAULT 'pending',-- pending|active|paused|suspended  [chain]
  keeper_enabled      BOOLEAN NOT NULL DEFAULT TRUE,  -- [chain]
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,
  description         TEXT NOT NULL DEFAULT '',
  logo_url            TEXT,
  website             TEXT,
  support_email       TEXT,
  webhook_url         TEXT,
  webhook_secret      TEXT,                           -- HMAC secret, shown once
  notify_on_payment   BOOLEAN NOT NULL DEFAULT TRUE,
  notify_on_failure   BOOLEAN NOT NULL DEFAULT TRUE,
  register_tx_hash    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS merchants_wallet_uq ON merchants (wallet_address);

CREATE TABLE IF NOT EXISTS plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       UUID NOT NULL REFERENCES merchants(id),
  onchain_plan_id   NUMERIC(78,0) UNIQUE,             -- [chain] NULL while draft
  slug              TEXT NOT NULL UNIQUE,             -- /subscribe/<slug>
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  features          JSONB NOT NULL DEFAULT '[]',      -- string[] bullet list for checkout
  visibility        TEXT NOT NULL DEFAULT 'public',   -- public|unlisted
  token_address     TEXT NOT NULL,                    -- [chain]
  price             NUMERIC(78,0) NOT NULL,           -- [chain] amount per period
  billing_interval  INTEGER NOT NULL,                 -- [chain] seconds
  trial_seconds     INTEGER NOT NULL DEFAULT 0,       -- [chain]
  intro_price       NUMERIC(78,0) NOT NULL DEFAULT 0, -- [chain]
  intro_periods     INTEGER NOT NULL DEFAULT 0,       -- [chain]
  max_subscribers   INTEGER NOT NULL DEFAULT 0,       -- [chain] 0 = unlimited
  terms_version     INTEGER NOT NULL DEFAULT 1,       -- [chain]
  status            TEXT NOT NULL DEFAULT 'draft',    -- draft|active|paused|archived  ([chain] once on-chain)
  create_tx_hash    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plans_merchant_idx ON plans (merchant_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onchain_subscription_id  NUMERIC(78,0) NOT NULL UNIQUE,  -- [chain]
  plan_id                  UUID NOT NULL REFERENCES plans(id),
  merchant_id              UUID NOT NULL REFERENCES merchants(id),
  subscriber_address       TEXT NOT NULL,                  -- [chain] lowercase
  token_address            TEXT NOT NULL,                  -- [chain]
  amount                   NUMERIC(78,0) NOT NULL,         -- [chain] snapshotted regular price
  intro_amount             NUMERIC(78,0) NOT NULL DEFAULT 0,
  intro_periods            INTEGER NOT NULL DEFAULT 0,
  billing_interval         INTEGER NOT NULL,               -- [chain]
  terms_version            INTEGER NOT NULL,               -- [chain]
  remaining_cap            NUMERIC(78,0) NOT NULL,         -- [chain]
  expires_at               TIMESTAMPTZ,                    -- [chain] NULL = no expiry
  next_billing_at          TIMESTAMPTZ NOT NULL,           -- [chain]
  payments_count           INTEGER NOT NULL DEFAULT 0,     -- [chain]
  total_paid               NUMERIC(78,0) NOT NULL DEFAULT 0,
  total_refunded           NUMERIC(78,0) NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'active', -- [chain] active|cancelled
  billing_status           TEXT NOT NULL DEFAULT 'ok',     -- off-chain: ok|retrying|past_due
  last_payment_at          TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  cancelled_by             TEXT,
  subscribe_tx_hash        TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL,           -- [chain] block time
  synced_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subs_subscriber_idx ON subscriptions (subscriber_address);
CREATE INDEX IF NOT EXISTS subs_merchant_idx ON subscriptions (merchant_id, status);
CREATE INDEX IF NOT EXISTS subs_due_idx ON subscriptions (status, next_billing_at);

-- One row per successful collection (from PaymentCollected) or per recorded failed attempt.
CREATE TABLE IF NOT EXISTS payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id   UUID NOT NULL REFERENCES subscriptions(id),
  merchant_id       UUID NOT NULL REFERENCES merchants(id),
  period_index      INTEGER NOT NULL,                 -- billing period (0 = first)
  amount            NUMERIC(78,0) NOT NULL,
  status            TEXT NOT NULL,                    -- succeeded|failed|refunded
  attempt_number    INTEGER NOT NULL DEFAULT 1,
  transaction_hash  TEXT,                             -- succeeded: the collect tx; failed: tx if on-chain PaymentFailed, else NULL
  log_index         INTEGER,
  block_number      BIGINT,
  collector         TEXT,                             -- merchant wallet or keeper
  payout_address    TEXT,
  billed_for        TIMESTAMPTZ,                      -- period start (nextBillingAt before the charge)
  failure_reason    TEXT,                             -- CollectionCheck value
  paid_at           TIMESTAMPTZ,                      -- block time
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Duplicate-charge guard at the DB layer (contract enforces it on-chain).
CREATE UNIQUE INDEX IF NOT EXISTS payments_success_uq ON payments (subscription_id, period_index) WHERE status = 'succeeded';
CREATE UNIQUE INDEX IF NOT EXISTS payments_tx_log_uq ON payments (transaction_hash, log_index) WHERE transaction_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_merchant_idx ON payments (merchant_id, paid_at DESC);

CREATE TABLE IF NOT EXISTS refunds (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  UUID NOT NULL REFERENCES subscriptions(id),
  merchant_id      UUID NOT NULL REFERENCES merchants(id),
  amount           NUMERIC(78,0) NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index        INTEGER NOT NULL,
  refunded_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (transaction_hash, log_index)
);

-- Durable scheduler state. Exactly one job per (subscription, period); the idempotency key.
CREATE TABLE IF NOT EXISTS billing_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id   UUID NOT NULL REFERENCES subscriptions(id),
  period_index      INTEGER NOT NULL,
  scheduled_at      TIMESTAMPTZ NOT NULL,             -- = next_billing_at for this period
  next_attempt_at   TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'scheduled',-- scheduled|processing|submitted|retrying|succeeded|failed_final|skipped|cancelled
  retry_count       INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   TIMESTAMPTZ,
  last_error        TEXT,                             -- CollectionCheck or RPC error summary
  tx_hash           TEXT,                             -- submitted collect tx (recovery after crash)
  tx_nonce          INTEGER,
  locked_by         TEXT,
  locked_until      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, period_index)
);
CREATE INDEX IF NOT EXISTS billing_jobs_due_idx ON billing_jobs (status, next_attempt_at);

-- Raw confirmed chain events; (tx_hash, log_index) makes ingestion idempotent.
CREATE TABLE IF NOT EXISTS chain_events (
  id            BIGSERIAL PRIMARY KEY,
  contract      TEXT NOT NULL,                        -- manager|registry
  event_name    TEXT NOT NULL,
  block_number  BIGINT NOT NULL,
  block_hash    TEXT NOT NULL,
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  args          JSONB NOT NULL,                       -- bigint as decimal strings
  block_time    TIMESTAMPTZ NOT NULL,
  processed_at  TIMESTAMPTZ,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_events_block_idx ON chain_events (block_number);

-- Indexer cursor + recent block hashes for reorg detection.
CREATE TABLE IF NOT EXISTS indexer_state (
  id                 TEXT PRIMARY KEY,                -- 'main'
  last_block         BIGINT NOT NULL,
  last_block_hash    TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS indexed_blocks (
  block_number  BIGINT PRIMARY KEY,
  block_hash    TEXT NOT NULL
);

-- Outgoing merchant webhooks (at-least-once, HMAC-SHA256 signed).
CREATE TABLE IF NOT EXISTS webhook_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id      UUID NOT NULL REFERENCES merchants(id),
  event_type       TEXT NOT NULL,                     -- subscription.created|payment.succeeded|payment.failed|subscription.cancelled|subscription.past_due|authorization.updated|refund.created
  dedupe_key       TEXT NOT NULL UNIQUE,              -- e.g. payment.succeeded:<tx>:<log>
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending|delivered|failed|skipped (no url)
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status_code INTEGER,
  last_error       TEXT,
  processed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_events_pending_idx ON webhook_events (status, next_attempt_at);

-- In-app notifications for subscribers and merchants (address-keyed so subscribers need no profile).
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address     TEXT NOT NULL,                          -- recipient wallet, lowercase
  kind        TEXT NOT NULL,                          -- payment_succeeded|payment_failed|past_due|subscription_cancelled|new_subscriber|upcoming_charge
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  link        TEXT,
  dedupe_key  TEXT NOT NULL UNIQUE,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_addr_idx ON notifications (address, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  actor        TEXT NOT NULL,                         -- wallet address, 'keeper', 'indexer', 'system'
  action       TEXT NOT NULL,
  resource_id  TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL
);

-- API idempotency for POSTs carrying an Idempotency-Key header.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,                      -- <address>:<header value>
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Remediation (2026-11-09): events whose handler failed permanently are kept with the error instead of stalling the indexer.
ALTER TABLE chain_events ADD COLUMN IF NOT EXISTS error TEXT;
