# MezoSub

**Recurring payments, powered by MUSD.** Non-custodial subscription billing on Mezo.

Merchants publish a plan and share a checkout link. Subscribers authorize a bounded recurring pull of MUSD from
their own wallet. When a payment is due, the merchant (one click) or MezoSub's keeper triggers collection, and the
contract checks every rule before any MUSD moves. The contract never holds funds.

> Status: **testnet MVP, not audited by a third party.** Contracts are live on Mezo Testnet and the subscription
> lifecycle passed end to end with two real wallets (below). The web app and worker are not hosted yet.

## Mezo Testnet deployment (chain 31611, 2026-11-13)

| | Address |
|---|---|
| SubscriptionManager | [`0xF5023D3D4f350102B855F1b0348ceED299104AD8`](https://explorer.test.mezo.org/address/0xF5023D3D4f350102B855F1b0348ceED299104AD8) |
| MerchantRegistry | [`0xC8AA181428732D4D1B2A2F2b5b5839baEb402d00`](https://explorer.test.mezo.org/address/0xC8AA181428732D4D1B2A2F2b5b5839baEb402d00) |
| MUSD (allowlisted) | [`0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`](https://explorer.test.mezo.org/address/0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503) |
| Keeper (`KEEPER_ROLE`) | [`0x79078Eca0064D01EE01812b3068A41535df6eD80`](https://explorer.test.mezo.org/address/0x79078Eca0064D01EE01812b3068A41535df6eD80) |

Deploy block 16751961, `MIN_INTERVAL` 300 s. Full record: `contracts/deployments/31611.json`.

Live end-to-end run (`npm run e2e:testnet`, 5 MUSD every 300 s):

| Step | Transaction |
|---|---|
| Merchant registers | [0x153a8c2f…](https://explorer.test.mezo.org/tx/0x153a8c2f3bbd2c36666975dcf9f9f716e08c0b886f279bd32abefe2e9310d836) |
| Plan created | [0xd93a3604…](https://explorer.test.mezo.org/tx/0xd93a360475140f1623b9bc32f650ea42283105c10a3b3660542ac0c2feedc757) |
| Subscriber approves the cap | [0x33d35686…](https://explorer.test.mezo.org/tx/0x33d35686faaf045473f73c543d1942c812779bf493fda9063010a6393197dd53) |
| Subscribe, first 5 MUSD charged | [0xc213fad5…](https://explorer.test.mezo.org/tx/0xc213fad51cdbc217f9101bc8e53aefb09067235c7ba2457f4ffa6f72c6d697c7) |
| Renewal after 300 s, 5 MUSD | [0x8a744298…](https://explorer.test.mezo.org/tx/0x8a7442981974d8c8304bce1dbdc99496f4e7e01b0a11ab09f303d90fa4620e14) |
| Subscriber cancels; next collect reverts `SubscriptionNotActive` | [0x39fe3af0…](https://explorer.test.mezo.org/tx/0x39fe3af0e98efb284fac07a4400c9b52d9d575d93a7c52301b0729d1967b57b5) |

The worker then indexed all 11 events into Postgres; stored totals match the chain (2 payments, 10 MUSD).

## How it works

| Step | Who | On-chain call |
|---|---|---|
| Register merchant | merchant wallet | `MerchantRegistry.registerMerchant(payout, metadataURI)` |
| Publish a plan | merchant | `SubscriptionManager.createPlan({token, amount, interval, trial, intro, maxSubscribers})` |
| Subscribe | subscriber | `subscribeWithPermit(...)` (one signature + one tx), or `approve` + `subscribe` |
| Renewal | keeper (worker) or merchant | `collectPayment(id)`: only when due, exact amount, to the merchant's payout |
| Cancel / revoke | subscriber (or merchant) | `cancelSubscription(id)` / `revokeAuthorization(id)` |
| Renew authorization | subscriber | `updateAuthorization(id, cap, expiresAt)` |
| Refund | merchant | `refund(id, amount)`, paid from the merchant's wallet |

The subscriber authorizes two things: an ERC-20 allowance to the manager (never unlimited by default), and a
per-subscription **spending limit** plus an optional end date that only they can change. A plan edit never touches
existing subscriptions: terms are snapshotted, and `subscribe` checks `expectedTermsVersion`.

Wallets connect through **Mezo Passport**: Bitcoin wallets (Unisat, OKX, Xverse) act through a Mezo smart account,
and Ethereum wallets (MetaMask, Rabby, any browser wallet) connect directly. Smart accounts can't sign MUSD's permit,
so they subscribe with approve + subscribe (two transactions) instead of one signature + one transaction.

Nothing runs by itself on-chain. Each renewal is a transaction sent by the worker's keeper (if the merchant enabled
it) or by the merchant from the dashboard ("Collect due payment").

## Repository

```
contracts/          Foundry: MerchantRegistry, SubscriptionManager, tests (unit, fuzz, invariants), Deploy script
app/                Next.js 16 pages (landing, /merchant/*, /subscribe/[slug], /account/*) + app/api/** routes
lib/chain/          chain config (addresses from env), generated ABIs, derived subscription state
lib/server/         DB, auth (signed wallet message), indexer, billing scheduler, webhooks, notifications
worker/run.ts       long-running worker: indexer → scheduler/keeper → webhooks
docs/               ARCHITECTURE (decisions, API table, env), SECURITY, AUDIT, notes-contracts
```

## Run locally

Requirements: Node 22, Foundry. Postgres is optional (PGlite is embedded), but the web app and worker can share
PGlite only in a single process; use a real Postgres (`DATABASE_URL`) to run both.

```bash
npm ci
cp .env.example .env.local          # fill contract addresses after deploying (below)
npm run dev                          # web on :3000
KEEPER_PRIVATE_KEY=0x... npm run worker   # indexer + keeper (needs DATABASE_URL shared with the web app)
```

### Full local stack against a Mezo Testnet fork (what the audit used)

```bash
anvil --fork-url https://rpc.test.mezo.org --chain-id 31611 --block-time 2
cd contracts && DEPLOYER_PRIVATE_KEY=<anvil key 0> KEEPER_ADDRESS=<anvil acct 3> MIN_INTERVAL=300 \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --legacy --slow
# .env.local: NEXT_PUBLIC_MEZO_RPC_URL=http://127.0.0.1:8545 + addresses from contracts/deployments/31611.json
# Real MUSD on the fork: impersonate any holder with anvil_impersonateAccount and transfer to a test wallet.
```

## Tests

```bash
cd contracts && forge test      # 102 tests: unit, fuzz (512 runs), 7 stateful invariants
npm test                        # 115 tests: server (PGlite, fake chain) + UI
npx tsc --noEmit && npx eslint . && npx next build
```

## Deploy

1. **Contracts** (Mezo Testnet, chain 31611). Put `DEPLOYER_PRIVATE_KEY` (funded with testnet BTC) and
   `KEEPER_ADDRESS` in `contracts/.env`, then:
   ```bash
   cd contracts && set -a && source .env && set +a
   forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --legacy --slow
   node script/record-deployment.mjs 31611 && cd .. && npm run abi
   ```
   Fund the keeper address with a little testnet BTC for gas.
2. **Database**: Neon or Supabase Postgres. Use the **session pooler** URL on Supabase (the direct `db.<ref>` host is
   IPv6-only). Set `DATABASE_SCHEMA=mezosub` to keep MezoSub's tables in their own schema when the database is
   shared. The schema is applied automatically on first use (`npm run db:migrate` to apply explicitly).
3. **Web** (Vercel): env from `.env.example` "web" section + contract addresses + `NEXT_PUBLIC_APP_URL` (the
   production URL; sign-in messages are pinned to it) + `SESSION_SECRET` + `INDEXER_SECRET`. **Never** set
   `KEEPER_PRIVATE_KEY` on Vercel.
4. **Worker** — two ways to run it (see [docs/WORKER_HOSTING.md](docs/WORKER_HOSTING.md)):
   - **Free (current):** a scheduler calls `POST /api/indexer/sync` on the web app every minute (Supabase `pg_cron`
     + `pg_net`). Each call runs one worker pass. Set `KEEPER_ON_WEB=true` and `KEEPER_PRIVATE_KEY` on the web host
     so the pass can send due collections.
   - **Render (later):** a long-running background worker from `render.yaml`. Same `DATABASE_URL`,
     `DATABASE_SCHEMA` and chain env, plus `KEEPER_PRIVATE_KEY`; then remove the keeper key from the web host.
5. Check `GET /api/health`: `deployed: true`, the worker is healthy, and indexer lag is a few blocks.

## Mezo facts used (verified live 2026-11-09)

Chain 31611, RPC `https://rpc.test.mezo.org`, gas in BTC, explorer `https://explorer.test.mezo.org`.
MUSD `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503`: "Mezo USD", 18 decimals, EIP-2612 permit (the domain separator
matches name "Mezo USD", version "1"; a test pins it).

## Mezo Passport notes

- Passport 0.17 needs wagmi 2 and RainbowKit 2. It declares React 18 peers for its UI kit; MezoSub only loads its
  wagmi config module (`@mezo-org/passport/dist/src/config`), which works on React 19. `.npmrc` sets
  `legacy-peer-deps=true` so installs (and Vercel) accept that.
- wagmi's connectors lazily import x402 packages MezoSub never uses; `next.config.ts` aliases them to an empty stub.

## Known limitations

See [docs/SECURITY.md](docs/SECURITY.md) for trust assumptions. In short:
- Months are fixed 30-day periods (weekly 7d, quarterly 91d, yearly 365d). The 5-minute plan is a labelled testnet demo.
- No back-billing: a late charge restarts the period from the charge time (the next charge is a full interval later).
- A subscription that still can't pay one full interval after its due date is cancelled on-chain by the next keeper
  batch, which frees its plan seat.
- Trial and intro pricing apply once per wallet per plan.
- Notifications are in-app and webhooks only (no email).
- Changing the price of a plan that is still a draft means creating a new draft.
- One active subscription per wallet per plan.
- No platform fee in the MVP.
