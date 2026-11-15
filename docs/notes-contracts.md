# MezoSub contracts: implementation notes

Written by the contracts agent. Source lives in `contracts/src/`, and the frozen interfaces in `contracts/src/interfaces/` are unchanged.

## Files

| Path | Purpose |
|---|---|
| `contracts/src/MerchantRegistry.sol` | `IMerchantRegistry` + `AccessControl` |
| `contracts/src/SubscriptionManager.sol` | `ISubscriptionManager` + `AccessControl` + `Pausable` + `ReentrancyGuard` |
| `contracts/script/Deploy.s.sol` | Deploys the registry and then the manager, allowlists MUSD, optionally grants `KEEPER_ROLE`, and writes `deployments/<chainId>.json` |
| `contracts/script/record-deployment.mjs` | Run after broadcasting. Puts the real tx hashes and the exact `deployBlock` from the broadcast receipts into the deployment JSON |
| `contracts/test/**` | Unit, fuzz and invariant suites, plus mocks (`MockMUSD` with EIP-2612, `FalseReturnToken`, `ReentrantToken`) |
| `scripts/export-abi.mjs` | Generates `lib/chain/abis.ts`. It now **fails** if the implementation ABI is missing any interface function, event or error (it compares the full signature, indexing, mutability and return types) |

## Design notes

- **Non-custodial.** Each charge is a single `transferFrom(subscriber → merchant.payout)`. The payout is read from the registry at collection time, so a payout change applies to the next collection. Refunds go `transferFrom(merchantOwner → subscriber)`. The manager never holds a balance, and an invariant asserts this.
- **One `_check`.** `previewCollection`, `collectPayment` and `collectDuePayments` all call `_check(subId, caller) → (CollectionCheck, amount, payout)`, so a preview can never disagree with a collection. Checks run in the spec order: NotFound → NotActive → NotAuthorized → MerchantInactive → ContractPaused → NotDue → AuthorizationExpired → SpendCapExceeded → InsufficientBalance → InsufficientAllowance. (The third return value, `payout`, avoids a second registry call.)
- **Token reads cannot revert a batch.** `balanceOf` and `allowance` go through a low-level `staticcall`. Any failure or short return data reads as 0, which then shows up as InsufficientBalance or InsufficientAllowance.
- **CEI.** `collectPayment` and `subscribe` (no-trial path) write all state and emit events, then do `safeTransferFrom` last. The batch path applies effects, calls `trySafeTransferFrom`, and if that returns false it restores `remainingCap`, `totalPaid`, `paymentsCount`, `lastPaymentAt` and `nextBillingAt` and emits `PaymentFailed(TransferFailed)`. `PaymentCollected` is emitted only after a successful transfer.
- **nonReentrant** is on every token-moving function: `subscribe`, `subscribeWithPermit`, `collectPayment`, `collectDuePayments` and `refund`. Tests use a re-entering token to show that both single and batch reentry fail with `ReentrancyGuardReentrantCall`.
- **Schedule.** The next billing time is the previous one plus `interval`. If that is already at or before `now`, it becomes `now + interval`, so there is no back-billing and no drift when a collection is late but still inside the period.
- **Registry read.** The manager reads merchant state through `MerchantRegistry.collectionInfo(id)` (owner, payout, status, keeperEnabled). This is an implementation-only view, not part of the frozen interface, and it avoids copying `metadataURI` on every collection. Because of this the manager needs the concrete `MerchantRegistry`, which is what we deploy.
- **No unbounded loops** in state-changing code. The only loop is the batch, capped at `MAX_BATCH = 50`. Pagination is view-only, clamps, and does not overflow on `offset`/`limit` near `type(uint256).max`.
- **Admin powers.** The admin can allowlist tokens, pause, and grant or revoke `KEEPER_ROLE` on the manager, and can suspend or unsuspend merchants on the registry. Nothing lets the admin or a keeper move tokens, change terms, or change a payout.

## Choices where the spec was silent (please review)

1. **`collectPayment` while paused** reverts with OpenZeppelin `Pausable.EnforcedPause()`, because the interface has no `ContractPaused` error. Batches emit `CollectionSkipped(ContractPaused)`.
2. **`updatePlan` on an Archived plan** reverts with `InvalidStatusTransition`.
3. **Owner-check errors.** Plan ops (`updatePlan`, `pausePlan`, `resumePlan`, `archivePlan`) revert with `NotPlanMerchant`. `createPlan` (caller has no merchant) and `refund` revert with `NotMerchantOwner`.
4. **`subscribe` also requires the plan token to still be allowlisted** (`TokenNotAllowed`). This lets the admin stop *new* subscriptions to a delisted token. Existing subscriptions keep collecting.
5. **`setTokenAllowed(address(0), …)`** reverts with `TokenNotAllowed`.
6. **Constructor validation** uses an implementation-only `error InvalidConfig()` (zero address, or `minInterval == 0 || minInterval > MAX_INTERVAL`). It appears in the generated ABI.
7. **`getMerchant`, `getPlan` and `getSubscription` revert** (`MerchantNotFound` / `PlanNotFound` / `SubscriptionNotFound`) for unknown ids. `amountDue`, `isDue` and `isActive` return 0/false.
8. **Trial subscriptions** still require `spendCap ≥ first charge`, but they do not check balance or allowance at subscribe time because nothing is charged yet.
9. **`cancelledBy`** in `SubscriptionCancelled` is `msg.sender` (the subscriber or the merchant owner). For `revokeAuthorization` it is the subscriber.
10. **`updateAuthorization`** checks in this order: NotFound → NotSubscriber → SubscriptionNotActive → InvalidAuthorization.

No interface changes were needed.

## Tests

`forge test`: **94 tests, all passing** across 8 suites.

| Suite | Tests |
|---|---|
| MerchantRegistry | 8 |
| Plans (constructor, admin, create/update validation, status, ownership transfer) | 13 |
| Subscribe (trial, no trial, intro sequence, guards, TermsChanged, PlanFull, pause, permit and front-run permit) | 18 |
| Collect (exact transfer, keeper, not-due, duplicate, back-billing, cancel, cross-merchant, random caller, keeper without role or keeperEnabled=false, cap, expiry, insufficient balance/allowance with no state change, failed payment does not advance, payout change, merchant pause/suspend, global pause, check order, reentrancy) | 25 |
| Lifecycle (cancel, revoke, updateAuthorization, refund, pagination) | 12 |
| Batch (BatchTooLarge, mixed batch with events, unauthorized, paused, transfer returns false or reverts → restore, 50-item batch) | 7 |
| Fuzz (amount/interval/warp, intro sequence, cap bound, pagination), 512 runs each | 4 |
| Invariant (handler: subscribe/collect/batch/cancel/revoke/updateAuthorization/approve/warp), 128 runs × depth 128 | 7 |

Invariants checked: payout balance equals the sum of `PaymentCollected` amounts; the manager's token balance is always 0; for each subscription, `totalPaid` equals the sum of period amounts over `paymentsCount` (intro-aware), and the total across subscriptions equals the payout balance; `remainingCap` never rises except through `updateAuthorization`; cancelled subscriptions never gain payments; `plan.activeSubscribers` and `activeSubscriptionOf` match the active set; `nextBillingAt > lastPaymentAt`.

## Gas (`forge test --gas-report`, solc 0.8.28, optimizer 200 runs)

| Operation | Gas |
|---|---|
| `subscribe`, no trial (charges period 0; first subscription for the wallet) | ~411,000 |
| `subscribe`, with trial (no charge) | ~346,000 |
| `subscribeWithPermit` (no trial) | ~427,000–464,000 |
| `collectPayment` (success) | ~90,000 (95,596 measured on anvil incl. 21k base) |
| `collectDuePayments` with 50 due subscriptions | 2,619,192 (~52,400 per item) |
| `cancelSubscription` | ~44,000 |
| `revokeAuthorization` (active) | ~50,000 |
| `updateAuthorization` | ~35,000 |
| `refund` | ~42,000–67,000 |
| `createPlan` | ~175,000 |
| `registerMerchant` | ~138,000 |
| Deploy `MerchantRegistry` / `SubscriptionManager` | 1,327,641 / 3,970,278 (runtime 5.8 KB / 17.9 KB) |

Most of the subscribe cost is the snapshot: about 10 fresh storage slots, plus the subscriber and merchant id lists.

## Deploying

```bash
cd contracts
cp .env.example .env   # or export the vars directly; contracts/.env is gitignored
# DEPLOYER_PRIVATE_KEY=0x...   (funded with testnet BTC for gas)
# KEEPER_ADDRESS=0x...         (optional; the worker's keeper wallet)
# MIN_INTERVAL=300             (optional, default 300)
# MUSD_ADDRESS=0x1189...       (optional, default testnet MUSD 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503)
set -a; source .env; set +a
forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --legacy --slow
node script/record-deployment.mjs 31611     # adds tx hashes + exact deployBlock
cd .. && node scripts/export-abi.mjs
```

Then set `NEXT_PUBLIC_REGISTRY_ADDRESS`, `NEXT_PUBLIC_MANAGER_ADDRESS` and `NEXT_PUBLIC_DEPLOY_BLOCK` from `contracts/deployments/31611.json`.

Local check (already done): `anvil` + `DEPLOY_MOCK_MUSD=true` (chain 31337 only) + `--legacy --slow`. All six transactions were type 0. The keeper role was granted, MUSD was allowlisted, and `MIN_INTERVAL` was 300. A subscribe charged 5 MUSD to payout. After 300 s the keeper's `collectPayment` succeeded (another 5 MUSD), a second collect reverted `NotDue`, and the manager balance stayed 0.
