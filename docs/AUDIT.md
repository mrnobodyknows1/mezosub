# MezoSub — Independent audit and remediation record (2026-11-09)

Scope: the whole repo at commit `096569f` (pre-audit baseline), audited against the original MezoSub brief.
Method: read the code; ran every suite; mutation-tested the contracts and the new regression tests; ran the real
app (`next build && next start`) with the worker and keeper against **real Postgres** and an **anvil fork of
Mezo Testnet using the real MUSD contract**, driven by two separate wallets through the same API and contract
calls the UI makes; browser pass (Chromium, desktop and mobile); an independent code review by a reviewer with no
prior context. Live Mezo Testnet deployment was **not** done (needs a funded key and the owner's go-ahead).

## A. Verdict

**WORKING MVP WITH SIGNIFICANT GAPS.** The full subscription lifecycle works end to end against the real MUSD
contract with real time passing. The significant gap is that **nothing is deployed**: no testnet contracts, no
hosted app, no public explorer links. Brief items 13 and 14 (deployed and reproducible by another person) are not met.

## B. Completion estimates (after remediation)

| Area | % | Basis |
|---|---|---|
| Code implementation | 90 | Every brief component exists and is wired up; no placeholders or mock data in app code (reviewer cross-checked every fetch path against a route) |
| Feature completeness | 85 | All lifecycle features. Missing: email notifications, editing a draft's price, keeper batching |
| Test quality | 80 | Contract guards 14/14 mutations caught; regression tests proven by reverting each fix; server tests use a fake chain (the real-chain proof is the E2E driver) |
| Integration verification | 85 | 39/39-step two-wallet E2E on a fork with real MUSD, real Postgres, real worker/keeper; plus a browser click-through with an injected EIP-1193 wallet (checkout via permit, account, cancel, merchant pages). Not done: live testnet, a real extension wallet |
| Security readiness | 65 | Sound contract invariants; 1 High, 3 Medium, 6 Low app findings fixed. No third-party audit |
| User experience | 85 | All public, subscriber and merchant screens rendered with real data in Chromium at desktop and mobile widths, with zero console errors and zero horizontal overflow |
| Deployment readiness | 25 | Deploy script proven on the fork, `render.yaml` and env documented. Nothing deployed |
| **Overall MVP readiness** | **75** | Deployment is the main missing piece |

## C. Requirements verification matrix

V = verified by execution, P = partially, U = unverified, F = failed, N = not implemented.

| Requirement | Status | Evidence |
|---|---|---|
| Merchant wallet sign-in (SIWE-style) | V | E2E "merchant SIWE sign-in"; tests cover replay, wrong domain, expiry, tampering |
| Merchant profile + on-chain registration | V | E2E registerMerchant tx + confirm → `chainStatus active` |
| Plan create (price, interval, trial, intro, cap) → publish | V (5 MUSD/300s) | E2E draft → chain-params → createPlan → confirm; trial/intro covered by contract tests only |
| Weekly/monthly/quarterly/yearly intervals | P | Fixed-second intervals; only the 300s demo interval exercised live |
| Edit metadata / pause / resume / archive | P | Contract tests + API code; not in the E2E |
| Existing subs keep their terms on plan edit | V (contract) | Snapshot + `TermsChanged` tests; mutation `terms` caught |
| Public checkout page | V | Browser with injected wallet: "Authorize and subscribe" → one permit signature + one tx → "You're subscribed" with an explorer link |
| Wrong-network handling | U | Component + UI test only (the injected test wallet reports the right chain) |
| Subscriber authorization (permit, cap, expiry) | V | E2E: permit on **real MUSD** set allowance = existing + cap exactly; domain separator test pinned to the live value |
| Approve fallback | P | Code path + domain-mismatch fallback; not executed live |
| Subscription on-chain + first charge | V | E2E: exactly 5 MUSD subscriber → merchant |
| Keeper/worker recurring collection | V | E2E: worker's keeper collected period 1 at the due time, no human involved |
| Manual "Collect due payment" | V | E2E: merchant collectPayment + sync; immediate duplicate reverts `NotDue` |
| Failed payment does not advance schedule | V | E2E: emptied wallet → `insufficient_balance`, on-chain `paymentsCount` unchanged, job `retrying` |
| Retry policy + restore | V | E2E: funded wallet + "Retry now" → collected, `billingStatus ok` |
| Cancel on-chain; collect after cancel fails | V | E2E: cancel tx + sync → `cancelled`; collect reverts `SubscriptionNotActive` |
| Revoke authorization / approve(0) | P | Contract tests; UI wired; not in the E2E |
| Refunds (merchant-initiated) | P | Contract tests + indexer; not in the E2E |
| Merchant dashboard figures from real data | V (API + browser) | E2E: overview revenue 5 → 20 MUSD, active 1 → 0, cancelled 1, failed 1, indexer lag 2 blocks |
| Subscriber dashboard | V (API + browser; cancel done through the UI) | E2E: subscription, 4 succeeded + 1 failed payment, allowance summary |
| Event indexer, idempotent, reorg-aware, reconciliation | V | Live: confirm replay idempotent, DB == chain totals; tests: reorg rewind + resync |
| Worker survives RPC outage | V | Live: anvil died mid-run; the worker kept looping (`ok:false`) without crashing |
| Webhooks (signed) | P | Unit tests (signing, backoff, SSRF); live delivery not exercised |
| Notifications | P | In-app rows verified by tests; no email |
| API authz / validation / rate limit / idempotency | V | E2E: 403 cross-user, 401 anonymous, 400 malformed, cross-site POST 403 |
| Contracts deployed to Mezo Testnet | **N** | Deploy script verified on the fork only |
| App hosted, worker hosted | **N** | `render.yaml` + Vercel steps written, not run |
| Explorer links to real testnet txs | **N** | Depends on deployment |
| Docs (README, security, limitations, deploy) | V | Added in remediation (README.md, docs/SECURITY.md, this file) |

## D. Findings (most severe first) and what was done

| # | Sev | Finding | Fix | Verified by |
|---|---|---|---|---|
| F1 | High | Ownership transfer onto a wallet whose pending profile had webhook rows → FK error → **indexer stalled for every merchant** (`indexer.ts` MerchantOwnershipTransferred; any wallet could trigger it) | Delete the dependent webhook rows first; plus **poison-event isolation**: a permanently failing event is stored with its error and indexing continues | Regression test fails when the fix is reverted; live repro step in the E2E |
| F2 | Medium | Chain re-reads (reconcile/confirm/keeper recovery) wrote absolute totals, then the PaymentCollected/Refunded handlers added the same amount again → inflated `total_paid`, deflated `remaining_cap` (UI could show "limit used up"); reorg rewind left totals stale | Deltas applied only while `payments_count <= periodIndex`; refunds use GREATEST(row, Σ refunds); rewind resyncs affected subscriptions from chain | 4 regression tests (3 fail when reverted); live "DB totals == chain totals" |
| F3 | Medium | Webhook SSRF check resolved DNS, then `fetch` resolved again (DNS-rebinding window) | `https.request` with a `lookup` that checks every answer at connect time | Tests: localhost refused with `EPRIVATEADDR` |
| F4 | Low | Transient RPC error while resolving an unknown subscription → event marked processed and **dropped forever** | Only "not found" reverts return null; RPC errors abort the pass (cursor not advanced) | Test fails when reverted |
| F5 | Low | Sign-in domain accepted request `Host`/`X-Forwarded-Host` | Pinned to `NEXT_PUBLIC_APP_URL` in production (+ `SIWE_EXTRA_DOMAINS`); rate-limit IP prefers `x-real-ip` | Test with forged headers |
| F6 | Low | Checkout with a past end date still enabled the button and subscribed with **no** end date | Button disabled while the date is invalid | tsc; code path |
| F7 | Low | Logs applied via confirm endpoints weren't tracked for reorg detection | `applyLogs` records block hashes | Covered by the reorg test |
| F8 | Low | Public plan endpoints exposed per-plan MRR | Public DTO zeroes `mrr` | Code |
| F9 | Low | Keeper could reuse a stale nonce now owned by another in-flight job (replacing its tx) | Reuse only if no other processing/submitted job holds it | Billing tests |
| F10 | Low | Permit domain version hardcoded; a mismatch would revert with no fallback | Compare our domain with the token's `DOMAIN_SEPARATOR` before signing; mismatch → approve path | Test pinned to the live MUSD separator |
| F11 | Low | ESLint linted vendored contract JS (1,242 "problems") | Ignore contracts/lib, out, broadcast | `eslint .` → 0 problems |
| F12 | Low | Landing content hidden (opacity 0) until scrolled: blank for crawlers, link previews and no-JS visitors | Reveal moves content but no longer hides it | Browser: server HTML has no `opacity:0` |
| F13 | Low | No README / security / limitations / deploy docs (brief deliverables) | Written | — |
| F14 | Info | Scheduler uses wall clock, contract uses block time | Documented; harmless recheck on skew | Observed during the audit (time-warp test) |
| F15 | Low | "Collected by" is computed against the merchant's *current* wallet, so collects made before an ownership transfer show "Other" | Not fixed (cosmetic) | Browser |

## E. Missing and shallow functionality (remaining)

- Not deployed (contracts, web, worker). Biggest gap.
- No email notifications (in-app + webhooks only).
- Keeper sends one tx at a time; `collectDuePayments` batching unused by the worker.
- Draft plan price can't be edited (create a new draft).
- Not exercised live: revoke, refund, plan pause/resume/archive, approve fallback, webhook delivery, trial/intro plans.

## F. Test quality

| Suite | Count | Result | Notes |
|---|---|---|---|
| Contracts (forge) | 94 | 94 pass | 4 fuzz × 512 runs, 7 invariants × 128 × depth 128; **14/14 guard mutations caught** |
| Server (vitest, PGlite) | 53 | 53 pass | Fake chain adapter. Two weak assertions strengthened; 11 regression tests added, each proven by reverting its fix |
| UI (vitest, jsdom) | 57 | 57 pass | Pure logic + rendering; no wallet interaction |
| Two-wallet E2E (fork, real MUSD) | 39 steps | 39 pass | Exercises real chain + DB + worker + keeper together, with real-time waits |
| Browser click-through (injected wallet) | 3 flows | pass | Checkout, account cancel, 6 merchant pages × 2 viewports; 0 console errors |

Confidence: high for contract invariants and the main lifecycle; medium for the indexer under adversarial
conditions (reorgs are tested with a fake chain only); medium for wallet-UI behaviour (clicked through with an injected
wallet, not a real extension).

## G. User experience

Every screen (landing, checkout, account, merchant overview/plans/subscribers/payments/billing/settings, 404, unavailable
plan) renders cleanly on desktop and mobile with real data, no console errors and no horizontal overflow. The
merchant overview reads well: revenue, MRR, five KPIs, a revenue chart, and recent payments with collector and tx links.
Failed attempts show a plain reason ("Not enough MUSD"). After cancelling, the account page points out the leftover
allowance and offers "Remove allowance". The checkout is clear about what's authorized ("Charged today",
next payment, spending limit "covers 12 payments", cancellation policy, network and contract) and never says
"pay once". The landing is restrained and honest about manual/keeper collection.

## H. Deployment and live verification

Nothing is deployed. Verified on a local anvil fork of Mezo Testnet (chain 31611, real MUSD
`0x1189…c503`), with real Postgres, `next start` and the worker + keeper:
- Pre-remediation build: **37/37** E2E steps passed (real-time waits, no time travel).
- Post-remediation build: **39/39**, including DB totals == chain totals (20 MUSD paid, 40 MUSD cap, 4 payments) and a live
  repro of F1: the indexer kept advancing past the ownership-transfer block.
- An RPC outage happened during one run (anvil died). The worker kept looping and reporting `ok:false` without crashing.
Fork tx hashes aren't explorer-verifiable and aren't claimed as testnet evidence.

## I. Remaining plan

- **P0:** deploy contracts to Mezo Testnet (needs the funded `deployer` key, whose keystore password only the owner has), fund the keeper, rerun `scripts/e2e-testnet.ts` with two real wallets, and record the tx hashes + explorer links in README.
- **P1:** host the web app (Vercel) + worker (Render) + Postgres (Neon/Supabase), then repeat the click-through with a real extension wallet on testnet.
- **P2:** keeper batching via `collectDuePayments`; email notifications; live webhook delivery test; draft price edit.
- **P3:** multisig admin; spam/limit controls for free-trial plans.

## J. Direct answers

1. Genuinely a working MVP? **Yes locally, with real MUSD and two wallets; not yet deployed.**
2. Usable without developer help? Not until it's hosted. Once deployed, the flows need no developer step.
3. Critical features implemented? Yes. The full lifecycle was exercised.
4. Tests meaningful? Contracts: yes (mutation-proven). Server: good with a fake chain; the E2E covers the gap.
5. Architecture sound? Yes. Non-custodial pull, chain-authoritative state, durable leased scheduler.
6. Good enough to submit? After P0 (testnet deploy + explorer-verifiable E2E), yes.
7. Top five before submission: testnet deploy; hosted web + worker; real-wallet UI pass; explorer links in README; short demo video.
8. Evidence still needed: deployed addresses, testnet tx hashes for subscribe/collect/cancel/failed collect, and a public URL.
