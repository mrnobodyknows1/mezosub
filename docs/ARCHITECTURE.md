# MezoSub — Architecture (FROZEN)

MezoSub is non-custodial recurring MUSD billing on Mezo. Merchants publish plans; subscribers authorize a
bounded recurring pull; the merchant or a keeper triggers each collection once it is due; the contract enforces
every rule. Postgres holds business metadata (names, logos, slugs, webhooks) plus an index of confirmed events.
**Smart-contract state is authoritative** for permissions, terms and billing schedule.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Payment model | Pull: `transferFrom(subscriber → merchant.payout)` per period | Contract never holds funds → no admin/escrow withdrawal surface. No prepaid lock-up. |
| Authorization | ERC-20 allowance to `SubscriptionManager` **plus** per-subscription `remainingCap` + optional `expiresAt` | Allowance is shared per spender, so the cap is what scopes each subscription. Only the subscriber edits it. |
| Approval UX | `subscribeWithPermit` (MUSD has EIP-2612, verified) → 1 signature + 1 tx; fallback `approve` + `subscribe` | Permit value = current allowance + new cap (never replaces another subscription's headroom). Never unlimited. |
| Who collects | Merchant owner, or `KEEPER_ROLE` when merchant `keeperEnabled` | Keeper can only trigger; amount/recipient/timing are fixed by contract. |
| Recurrence | No autonomous execution. Worker scheduler (keeper) + "Collect due payment" button | EVM can't self-schedule. |
| Schedule | `nextBillingAt += interval`; if still ≤ now → `now + interval` (no back-billing for missed periods) | One charge per collection; a lapsed sub resumes, it isn't charged for every missed month. |
| Term changes | Subscriptions snapshot terms; `updatePlan` bumps `termsVersion`, affects new subscribers only; subscribe checks `expectedTermsVersion` | No silent changes, no front-running a price hike. |
| Months | Fixed 30-day intervals (weekly 7d, quarterly 91d, yearly 365d). Testnet demo plan: 300s, labelled | Calendar months off-chain only would break on-chain due checks. `MIN_INTERVAL` is a deploy-time immutable (testnet 300). No time-warp backdoor. |
| Contracts | `MerchantRegistry` + `SubscriptionManager` (plans, subs, collection, refunds) | PaymentProcessor folded in: one less trust edge. |
| Fees | None in MVP | Disclosed as "0% platform fee". |
| Stack | Next.js 16 App Router, TS strict, wagmi 3 + viem, TanStack Query, zod, Tailwind 4, postgres.js (PGlite fallback), Foundry (solc 0.8.28, cancun, OZ 5.4) | Same as prior Mezo builds. |
| Wallets | Mezo Passport (`@mezo-org/passport` on RainbowKit + wagmi 2, `lib/client/wagmi.ts`): Bitcoin wallets (Unisat, OKX, Xverse) through a Mezo smart account; MetaMask, Rabby and other browser wallets directly | Bitcoin holders can subscribe with the wallet they already have. Smart-account signatures are ERC-1271, so they skip MUSD permit and use approve + subscribe; sign-in already verifies ERC-1271/6492. |
| Auth | Signed nonce (personal_sign, SIWE-style text incl. domain, chainId, nonce, issuedAt) → httpOnly HMAC-signed session cookie (DB-backed) | Wallet ownership proven; client-supplied addresses never trusted. |
| Worker | `worker/run.ts` long-running process (Render background worker): indexer → scheduler → webhooks → notifications, every `WORKER_INTERVAL_MS` (default 15s) | Not dependent on a browser tab or Vercel cron. API also verifies receipts on demand so UI updates immediately. |
| Hosting | Vercel (web), Supabase Postgres; worker: free mode = scheduler calls `/api/indexer/sync` every minute, later Render background worker | See docs/WORKER_HOSTING.md. |

## Subscription lifecycle

```
 subscribe ─┬─ trial == 0 → charge period 0 now → Active (next = now+interval)
            └─ trial  > 0 → no charge          → Active (next = now+trial)      [derived: trialing]

 Active ──(now ≥ next)──▶ due ──collectPayment ok──▶ Active (paymentsCount++, cap -= amt, next advances)
                              └─ funding failure ─▶ unchanged on-chain; worker retries per policy → past_due (off-chain)
 Active ──cancelSubscription (subscriber|merchant)──▶ Cancelled (terminal; any collect reverts)
 Active ──revokeAuthorization (subscriber)──▶ cap = 0 + Cancelled
 Derived (pure fn lib/chain/subscription-state.ts): trialing | active | due | past_due | expired | cap_exhausted | cancelled
```

## Scheduler (worker) semantics

1. **Indexer** (`getLogs` both contracts from cursor to `head - CONFIRMATIONS` (default 2), chunks ≤ 2,000 blocks).
   Stores `chain_events` (unique tx_hash+log_index), applies them to tables idempotently, records block hashes in
   `indexed_blocks`; on startup and each pass re-checks the last 12 stored hashes — mismatch → delete events/rows from
   that block onward, rewind cursor, re-index (reorg-aware). Every N passes it **reconciles**: re-reads
   `getSubscription` for all active subs and overwrites [chain] columns; mismatches are logged to `audit_logs`.
2. **Job planner**: for every active subscription ensure a `billing_jobs` row for `(sub, paymentsCount)` with
   `scheduled_at = next_billing_at`. Rows for older periods that were paid → `succeeded`; cancelled subs → `cancelled`.
3. **Executor**: claims due jobs (`status in (scheduled, retrying) and next_attempt_at ≤ now`) with a lease
   (`UPDATE … SET locked_by, locked_until WHERE … RETURNING`, `FOR UPDATE SKIP LOCKED` on Postgres). For each:
   `previewCollection(subId, keeper)` →
   - `ok` → `collectPayment` (keeper key), persist `tx_hash`+`tx_nonce` **before** waiting, wait receipt, verify a
     `PaymentCollected` log with matching subId + periodIndex → `succeeded` (payment row inserted by the same log
     handler as the indexer — one code path).
   - `not_due` → if chain `paymentsCount > period` it was paid elsewhere → `succeeded`; else reschedule to chain `nextBillingAt`.
   - funding failures (`RETRYABLE_CHECKS`) → insert `payments` row `failed` (attempt n), `retrying` with
     `next_attempt_at = now + RETRY_DELAYS[n]`; after the last → `failed_final`, subscription `billing_status = past_due`,
     notifications + `payment.failed`/`subscription.past_due` webhooks. Subscriber restores by funding/renewing; the
     next successful collect (manual or keeper retry after they press "Retry now") resets `billing_status = ok`.
   - `not_active`/`authorization_expired`/`spend_cap_exceeded`/`merchant_inactive`/`not_authorized` → `skipped` (no retry).
   - RPC errors → job back to `retrying` with short backoff, not counted as a payment failure.
4. **Crash recovery**: jobs in `processing` past `locked_until` are re-claimed; jobs in `submitted` with `tx_hash`
   → fetch receipt; none after `TX_TIMEOUT` and chain `paymentsCount` still ≤ period → resubmit with the same nonce
   (replacement) or fresh preview. Duplicate execution is harmless: the contract rejects a second charge (NotDue).
5. **Webhooks**: deliver `webhook_events` (pending, `next_attempt_at ≤ now`), 5 attempts with exponential backoff.
6. Worker heartbeat: `indexer_state` row `id='worker'` (`last_block` unused, `updated_at` = last run) → `/api/health`.

Default `RETRY_DELAYS_SECONDS = 86400,172800` (24h, then 48h). If `BILLING_DEMO_MODE=1`, delays are `120,300` and the UI says so.

## Repository layout & ownership

| Path | Owner |
|---|---|
| `contracts/**`, `scripts/export-abi.mjs`, `lib/chain/abis.ts` (generated) | Contracts agent. Interfaces in `contracts/src/interfaces/` are FROZEN |
| `lib/chain/config.ts`, `lib/chain/subscription-state.ts`, `lib/api-types.ts`, `lib/server/db/schema.sql`, `docs/ARCHITECTURE.md` | Lead — FROZEN |
| `lib/server/**` (except schema.sql), `lib/money.ts`, `app/api/**`, `worker/**`, `tests/server/**`, `render.yaml` | Backend agent |
| `app/**` (except `app/api`), `components/**`, `hooks/**`, `lib/client/**`, `public/**`, `tests/ui/**`, `app/globals.css` | Frontend agent |
| `README.md`, `docs/*.md` other than ARCHITECTURE | Lead, at the end (agents may add notes to `docs/notes-<agent>.md`) |

Shared pure module the backend writes **first** (frontend imports it): `lib/money.ts` —
`parseMusd(human: string): bigint` (throws on invalid / >18 decimals / negative), `formatMusd(wei: bigint | string,
opts?: { decimals?: number; compact?: boolean; symbol?: boolean }): string`, `MUSD_UNIT = 10n ** 18n`,
`monthlyNormalized(amountWei: bigint, intervalSeconds: number): bigint` (amount × 30d / interval, integer math).

## API routes (JSON; types in lib/api-types.ts)

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/auth/nonce` · `POST /api/auth/verify` · `GET /api/auth/session` · `POST /api/auth/logout` | – | Wallet sign-in |
| `GET /api/health` | – | HealthResponse |
| `POST /api/merchants` · `GET/PATCH /api/merchants/me` | session | Create pending profile / read / update metadata |
| `POST /api/merchants/me/confirm` | session | `{txHash}` of registerMerchant / setPayout / setKeeperEnabled / pause / resume → verify + sync |
| `POST /api/merchants/me/webhook-secret` | merchant | RotateWebhookSecretResponse |
| `POST /api/merchants/me/webhook-test` | merchant | Enqueue a `ping` webhook |
| `GET /api/merchants/me/overview` | merchant | MerchantOverviewDTO |
| `GET /api/plans` · `POST /api/plans` | merchant | My plans / create draft |
| `GET/PATCH /api/plans/:id` | merchant | Plan / metadata edit |
| `GET /api/plans/:id/chain-params` | merchant | PlanChainParams for createPlan/updatePlan |
| `POST /api/plans/:id/confirm` | merchant | `{txHash}` of createPlan/updatePlan/pause/resume/archive → verify + sync |
| `GET /api/public/plans/:slug` | – | CheckoutDTO (live chain read) |
| `GET /api/public/merchants/:slug` | – | PublicMerchantDTO + public active plans |
| `GET /api/subscriptions?scope=merchant\|subscriber&status=&page=` | session | Paginated<SubscriptionDTO> |
| `POST /api/subscriptions/confirm` | – (rate-limited) | `{txHash}` of subscribe → verify `Subscribed` log → SubscriptionDTO |
| `GET /api/subscriptions/:id` | subscriber or merchant of it | SubscriptionDetailDTO |
| `POST /api/subscriptions/:id/sync` | subscriber or merchant | `{txHash?}` (collect/cancel/revoke/updateAuthorization/refund) → verify + re-read chain |
| `POST /api/subscriptions/:id/retry` | subscriber or merchant | Re-queue a `retrying`/`failed_final` job now (no chain write) |
| `POST /api/subscriptions/:id/cancel` | subscriber or merchant | Returns the tx to sign (`{to, data}`) — cancellation itself is on-chain only |
| `GET /api/subscriptions/:id/payments` | subscriber or merchant | PaymentDTO[] |
| `GET /api/payments?page=&status=` · `GET /api/payments/export.csv` | merchant | Paginated<PaymentDTO> / CSV (formula-injection safe) |
| `GET /api/billing` | merchant | BillingOverviewDTO |
| `GET /api/me/subscriptions` | session | SubscriberDashboardDTO |
| `GET /api/notifications` · `POST /api/notifications/read` | session | In-app notifications |
| `POST /api/indexer/sync` | `Bearer $INDEXER_SECRET` | One worker pass (cron fallback) |

Every POST: zod validation, rate limit (`rate_limits`), optional `Idempotency-Key` header. Every tx-confirm
endpoint verifies: receipt `status=success`, `to` is the expected contract, expected event present, and `from`
(or event actor) equals the session wallet where an actor matters. Client-reported payment status is never trusted.

## Environment

| Var | Used by |
|---|---|
| `NEXT_PUBLIC_MEZO_RPC_URL`, `NEXT_PUBLIC_MUSD_ADDRESS`, `NEXT_PUBLIC_MANAGER_ADDRESS`, `NEXT_PUBLIC_REGISTRY_ADDRESS`, `NEXT_PUBLIC_DEPLOY_BLOCK` | web, worker |
| `NEXT_PUBLIC_APP_URL` | checkout links |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | optional; adds WalletConnect to the Mezo Passport modal |
| `NEXT_PUBLIC_BILLING_DEMO_MODE` / `BILLING_DEMO_MODE` | demo retry delays + UI label |
| `DATABASE_URL` (unset → PGlite at `.data/pglite`) | API, worker |
| `SESSION_SECRET` (≥32 chars) | API |
| `INDEXER_SECRET` | `/api/indexer/sync` |
| `KEEPER_PRIVATE_KEY` | **worker only** (never web). Holds only gas + KEEPER_ROLE. |
| `RETRY_DELAYS_SECONDS`, `CONFIRMATIONS`, `WORKER_INTERVAL_MS` | worker |
| `DEPLOYER_PRIVATE_KEY`, `KEEPER_ADDRESS`, `MIN_INTERVAL` | contracts/.env only |
