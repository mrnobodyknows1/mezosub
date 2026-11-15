# MezoSub — Security model and remaining risks

Not audited by a third party. This document is what an operator or reviewer should know.

## What the contract guarantees

| Invariant | Enforced by | Test evidence |
|---|---|---|
| Funds go only subscriber → merchant payout; the contract never holds tokens | single `transferFrom` per charge | invariant `manager balance == 0`, payout == Σ PaymentCollected |
| Never more than the subscriber authorized | `remainingCap` (only the subscriber raises it) + ERC-20 allowance | cap tests, fuzz, invariant `cap only increases via updateAuthorization` |
| Never before due, never closer than one interval | `block.timestamp >= nextBillingAt`; each charge sets the next due time to charge time + interval | duplicate-collect tests, `test_collect_lateCollectionLeavesFullInterval`; live: second collect reverts `NotDue` |
| A failed payment doesn't advance the schedule | revert (single) / state restore (batch) | batch transfer-failure restore test; live: insufficient balance kept `paymentsCount` |
| Cancelled subscriptions can't be charged | status check first | live: collect after cancel reverts `SubscriptionNotActive` |
| Merchants can't change existing terms | terms snapshot + `expectedTermsVersion` | plan-update tests, `TermsChanged` guard |
| Keeper can't redirect, change amount or timing | keeper only triggers `collect*`; merchant opt-in `keeperEnabled` | unauthorized keeper tests |
| Admin can't move funds | no such function exists | code review |
| Tokens never end up in a contract | a payout equal to the manager or the token is refused at subscribe and treated as `MerchantInactive` at collection | `test_payoutSetToManager_*` |
| Trial and intro price once per wallet per plan | `hasSubscribed` record; a returning wallet pays the full price at subscribe | `test_resubscribe_noSecondTrialOrIntro` |
| A suspended merchant stays with its owner | `transferMerchantOwnership` reverts while Suspended | `test_suspendedMerchant_cannotBeTransferred` |
| Subscriptions that can't pay don't hold seats forever | `collectDuePayments` cancels a subscription still failing (no funds, no allowance, expired, cap used up) one full interval after its due date; the worker sends these batches | `test_unfundedTrial_seatReleasedAfterGrace`, `test_expiredAuthorization_seatReleasedAfterGrace`, `releaseLapsed` tests |

All 14 targeted mutations of the contract's guards (authorization, keeper opt-in, due check, cancel check, cap,
expiry, back-billing, cap decrement, batch restore, terms guard, subscriber-only auth update, cancel auth, refund
cap, payout target) were caught by the test suite (see AUDIT.md).

## Trust assumptions

- **Admin (deployer)** can pause `subscribe`/`collect` (cancel, revoke, authorization updates and refunds still
  work), allowlist tokens, grant/revoke `KEEPER_ROLE`, and suspend a merchant. Pausing can delay merchant revenue.
  Use a multisig for mainnet.
- **Keeper key** lives only on the worker. If it's stolen, the attacker can trigger collections that were already
  due, to the merchant's own payout and for the exact amount. That costs the attacker gas and gains them nothing.
  Rotate it with `revokeRole`/`grantRole`. Merchants can opt out with `setKeeperEnabled(false)`.
- **Merchant owner key** controls the payout address. A compromised merchant key can redirect *future* collections
  of its own subscriptions and nothing else.
- **ERC-20 allowance is shared** across a subscriber's MezoSub subscriptions (one spender). The per-subscription
  cap is what scopes each one; the UI adds to the existing allowance instead of replacing it.
- **Off-chain database is not authoritative.** Payments are recorded only from confirmed `PaymentCollected` logs,
  either through receipt verification (status, target contract, sender, emitter) or through the indexer.
  Reconciliation re-reads chain state periodically.

## Application security

- Sign-in: single-use nonce bound to the address, with domain, chainId and expiry checked. In production the
  domain is pinned to `NEXT_PUBLIC_APP_URL` (plus `SIWE_EXTRA_DOMAINS`); request headers are not trusted.
  Sessions are DB-backed, HMAC-signed and httpOnly.
- Cross-site POSTs rejected (Origin check), zod validation everywhere, per-route rate limits, Idempotency-Key.
- Every subscription read is restricted to its subscriber or its merchant; merchant routes are scoped by merchant id.
  Public plan endpoints don't expose revenue.
- Webhooks: https only, HMAC-SHA256 signed (`t=…,v1=…`), no redirects. Private and loopback addresses are refused
  at connect time (DNS answers are checked inside the socket lookup, so there is no rebinding window).
- Indexer: idempotent per (tx, logIndex). Reorg detection re-checks recent block hashes and resyncs affected
  subscriptions from chain. A permanently failing event is recorded with its error instead of stalling indexing;
  RPC failures abort the pass and retry.

## Remaining risks / not done

- No third-party audit; no formal verification.
- Spam: anyone can register a merchant or subscribe to a free-trial plan (no charge at signup). An unfunded
  subscription now gives its plan seat back one interval after the trial ends, but many fresh wallets can still hold
  seats for that long. Rate limits cover the API but not direct contract calls.
- Clock: the scheduler plans with wall-clock time; the contract decides with block time. Skew only causes harmless
  "not due yet" rechecks.
- The keeper sends one transaction at a time; throughput is about one collection per block-confirmation round trip
  (`collectDuePayments` batching exists on-chain but the worker doesn't use it yet).
- Email notifications aren't implemented (in-app and webhooks only).

## Second review (2026-11-12, pashov solidity-auditor, 2 passes, 24 agents)

Five findings, all fixed with a regression test that fails on the old code: suspended owner escaping suspension by
transfer, two charges one second apart after a late collection, payout set to the manager locking tokens, trial and
intro price repeated by cancel + resubscribe, and plan seats held by subscriptions that cannot pay. Leads that were
judged design choices (payout read at collection, delisted token still collects, paused plan still bills existing
subscribers, refund does not restore the cap, keeper on by default, single admin EOA) are listed in
`contracts/.solidity-auditor/runs/20261112-190335/run-2.md`.
