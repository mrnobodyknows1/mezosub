// End-to-end check against Mezo Testnet (REAL transactions; costs testnet gas + 10 MUSD of the subscriber).
//   MERCHANT_PRIVATE_KEY=0x… SUBSCRIBER_PRIVATE_KEY=0x… npm run e2e:testnet
// Addresses come from env (NEXT_PUBLIC_MANAGER_ADDRESS / NEXT_PUBLIC_REGISTRY_ADDRESS / NEXT_PUBLIC_MUSD_ADDRESS) or
// contracts/deployments/31611.json. Optional: E2E_API_URL=http://localhost:3000 also posts each tx to the confirm APIs.
//
// Steps: registerMerchant (reused if the wallet already has one) → createPlan 5 MUSD / 300s → approve(cap) + subscribe
// (first charge) → wait until due → merchant collectPayment → assert MUSD deltas → subscriber cancel →
// assert collectPayment simulation reverts SubscriptionNotActive.

import "../worker/load-env";
import fs from "node:fs";
import path from "node:path";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, merchantRegistryAbi, subscriptionManagerAbi } from "../lib/chain/abis";
import { MUSD_TESTNET, explorerTx, mezoTestnet, paddedGas } from "../lib/chain/config";
import { formatMusd } from "../lib/money";

const E18 = 10n ** 18n;
const PRICE = 5n * E18;
const INTERVAL = 300;

function need(name: string): Hex {
  const v = process.env[name];
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) {
    console.error(`Missing/invalid ${name}`);
    process.exit(2);
  }
  return v as Hex;
}

function addresses(): { manager: Address; registry: Address; musd: Address } {
  let file: Record<string, unknown> = {};
  const p = path.join(process.cwd(), "contracts/deployments/31611.json");
  if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, "utf8"));
  const pick = (env: string, ...keys: string[]) => {
    const v = process.env[env] || keys.map((k) => file[k]).find((x) => typeof x === "string");
    return v && /^0x[0-9a-fA-F]{40}$/.test(String(v)) ? (v as Address) : null;
  };
  const manager = pick("NEXT_PUBLIC_MANAGER_ADDRESS", "SubscriptionManager", "subscriptionManager", "manager");
  const registry = pick("NEXT_PUBLIC_REGISTRY_ADDRESS", "MerchantRegistry", "merchantRegistry", "registry");
  const musd = pick("NEXT_PUBLIC_MUSD_ADDRESS", "MUSD", "musd") ?? MUSD_TESTNET;
  if (!manager || !registry) {
    console.error("Manager/registry addresses not found (env or contracts/deployments/31611.json)");
    process.exit(2);
  }
  return { manager, registry, musd };
}

const rpc = process.env.NEXT_PUBLIC_MEZO_RPC_URL || mezoTestnet.rpcUrls.default.http[0];
const pub = createPublicClient({ chain: mezoTestnet, transport: http(rpc) });
const merchant = privateKeyToAccount(need("MERCHANT_PRIVATE_KEY"));
const subscriber = privateKeyToAccount(need("SUBSCRIBER_PRIVATE_KEY"));
const mw = createWalletClient({ account: merchant, chain: mezoTestnet, transport: http(rpc) });
const sw = createWalletClient({ account: subscriber, chain: mezoTestnet, transport: http(rpc) });
const { manager, registry, musd } = addresses();
/** Writes with a padded gas limit (Mezo RPC estimates can fall below the EIP-7623 floor; see paddedGas). */
async function padded(wc: typeof mw, args: Record<string, unknown>): Promise<Hex> {
  const gas = paddedGas(await pub.estimateContractGas({ ...args, account: wc.account } as never));
  return wc.writeContract({ ...args, gas } as never);
}
const apiUrl = process.env.E2E_API_URL?.replace(/\/+$/, "");

function step(msg: string) {
  console.log(`\n▶ ${msg}`);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

async function send(label: string, hashP: Promise<Hex>): Promise<TransactionReceipt> {
  const hash = await hashP;
  console.log(`  ${label}: ${explorerTx(hash)}`);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  assert(r.status === "success", `${label} mined in block ${r.blockNumber}`);
  return r;
}

function events(r: TransactionReceipt, abi: typeof subscriptionManagerAbi | typeof merchantRegistryAbi, address: Address) {
  return r.logs
    .filter((l) => l.address.toLowerCase() === address.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi, topics: l.topics, data: l.data });
      } catch {
        return null;
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null) as { eventName: string; args: Record<string, unknown> }[];
}

const balanceOf = (a: Address) => pub.readContract({ address: musd, abi: erc20Abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

async function postApi(pathname: string, txHash: Hex) {
  if (!apiUrl) return;
  try {
    const r = await fetch(`${apiUrl}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash }) });
    console.log(`  API ${pathname} → ${r.status}`);
  } catch (e) {
    console.log(`  API ${pathname} failed: ${(e as Error).message}`);
  }
}

async function main() {
  console.log(`MezoSub E2E on chain ${await pub.getChainId()} via ${rpc}`);
  console.log(`  manager ${manager}\n  registry ${registry}\n  MUSD ${musd}\n  merchant ${merchant.address}\n  subscriber ${subscriber.address}`);

  // ---------------------------------------------------------------- merchant
  step("Merchant registration");
  let merchantId = (await pub.readContract({ address: registry, abi: merchantRegistryAbi, functionName: "merchantIdOf", args: [merchant.address] })) as bigint;
  if (merchantId === 0n) {
    const r = await send("registerMerchant", padded(mw, { address: registry, abi: merchantRegistryAbi, functionName: "registerMerchant", args: [merchant.address, "mezosub:merchant:e2e"] }));
    const ev = events(r, merchantRegistryAbi, registry).find((e) => e.eventName === "MerchantRegistered");
    assert(ev, "MerchantRegistered emitted");
    merchantId = ev.args.merchantId as bigint;
  } else console.log(`  reusing merchant #${merchantId}`);
  const m = (await pub.readContract({ address: registry, abi: merchantRegistryAbi, functionName: "getMerchant", args: [merchantId] })) as { payout: Address; status: number };
  assert(Number(m.status) === 1, "merchant is Active");
  const payout = m.payout;

  // ---------------------------------------------------------------- plan
  step("createPlan 5 MUSD every 300s");
  const r1 = await send(
    "createPlan",
    padded(mw, {
      address: manager,
      abi: subscriptionManagerAbi,
      functionName: "createPlan",
      args: [{ token: musd, amount: PRICE, interval: INTERVAL, trialPeriod: 0, introAmount: 0n, introPeriods: 0, maxSubscribers: 0 }],
    }),
  );
  const pc = events(r1, subscriptionManagerAbi, manager).find((e) => e.eventName === "PlanCreated");
  assert(pc, "PlanCreated emitted");
  const planId = pc.args.planId as bigint;
  const plan = (await pub.readContract({ address: manager, abi: subscriptionManagerAbi, functionName: "getPlan", args: [planId] })) as { termsVersion: number };

  // ---------------------------------------------------------------- subscribe
  step("Subscriber approve(cap) + subscribe (first charge now)");
  const cap = PRICE * 3n;
  const subBal0 = await balanceOf(subscriber.address);
  assert(subBal0 >= PRICE * 2n, `subscriber holds ≥ 10 MUSD (has ${formatMusd(subBal0)}; top up at https://testnet.mezo.org)`);
  const allowance = (await pub.readContract({ address: musd, abi: erc20Abi, functionName: "allowance", args: [subscriber.address, manager] })) as bigint;
  // Add this subscription's cap on top of the existing allowance (never clobber other subscriptions' headroom).
  await send("approve", padded(sw, { address: musd, abi: erc20Abi, functionName: "approve", args: [manager, allowance + cap] }));
  const payBal0 = await balanceOf(payout);
  const r2 = await send(
    "subscribe",
    padded(sw, { address: manager, abi: subscriptionManagerAbi, functionName: "subscribe", args: [planId, Number(plan.termsVersion), cap, 0n] }),
  );
  await postApi("/api/subscriptions/confirm", r2.transactionHash);
  const evs = events(r2, subscriptionManagerAbi, manager);
  const subscribed = evs.find((e) => e.eventName === "Subscribed");
  assert(subscribed, "Subscribed emitted");
  assert(evs.some((e) => e.eventName === "PaymentCollected" && Number(e.args.periodIndex) === 0), "first period charged (PaymentCollected #0)");
  const subId = subscribed.args.subscriptionId as bigint;
  const subBal1 = await balanceOf(subscriber.address);
  const payBal1 = await balanceOf(payout);
  assert(subBal0 - subBal1 === PRICE, `subscriber paid exactly 5 MUSD`);
  if (payout.toLowerCase() !== subscriber.address.toLowerCase()) assert(payBal1 - payBal0 === PRICE, "merchant payout received exactly 5 MUSD");

  // ---------------------------------------------------------------- renewal
  step("Wait until due, then merchant collectPayment");
  const s0 = (await pub.readContract({ address: manager, abi: subscriptionManagerAbi, functionName: "getSubscription", args: [subId] })) as { nextBillingAt: bigint };
  for (;;) {
    const block = await pub.getBlock();
    const left = Number(s0.nextBillingAt - block.timestamp);
    if (left <= 0) break;
    process.stdout.write(`  due in ${left}s…\r`);
    await new Promise((r) => setTimeout(r, Math.min(15, left + 2) * 1000));
  }
  const [check] = (await pub.readContract({ address: manager, abi: subscriptionManagerAbi, functionName: "previewCollection", args: [subId, merchant.address] })) as readonly [number, bigint];
  assert(Number(check) === 0, "previewCollection(merchant) == Ok");
  const r3 = await send("collectPayment", padded(mw, { address: manager, abi: subscriptionManagerAbi, functionName: "collectPayment", args: [subId] }));
  assert(events(r3, subscriptionManagerAbi, manager).some((e) => e.eventName === "PaymentCollected" && Number(e.args.periodIndex) === 1), "PaymentCollected #1");
  const subBal2 = await balanceOf(subscriber.address);
  const payBal2 = await balanceOf(payout);
  assert(subBal1 - subBal2 === PRICE, "subscriber charged exactly 5 MUSD again");
  if (payout.toLowerCase() !== subscriber.address.toLowerCase()) assert(payBal2 - payBal1 === PRICE, "merchant payout +5 MUSD");
  const s1 = (await pub.readContract({ address: manager, abi: subscriptionManagerAbi, functionName: "getSubscription", args: [subId] })) as { paymentsCount: number; remainingCap: bigint };
  assert(Number(s1.paymentsCount) === 2 && s1.remainingCap === cap - PRICE * 2n, "paymentsCount = 2, remainingCap = cap − 10 MUSD");

  // ---------------------------------------------------------------- cancel
  step("Subscriber cancels; further collection must revert");
  const r4 = await send("cancelSubscription", padded(sw, { address: manager, abi: subscriptionManagerAbi, functionName: "cancelSubscription", args: [subId] }));
  assert(events(r4, subscriptionManagerAbi, manager).some((e) => e.eventName === "SubscriptionCancelled"), "SubscriptionCancelled emitted");
  try {
    await pub.simulateContract({ account: merchant, address: manager, abi: subscriptionManagerAbi, functionName: "collectPayment", args: [subId] });
    assert(false, "collectPayment after cancel should revert");
  } catch (e) {
    const rev = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    const name = rev instanceof ContractFunctionRevertedError ? rev.data?.errorName : undefined;
    assert(name === "SubscriptionNotActive", `collectPayment simulation reverts SubscriptionNotActive (got ${name ?? (e as Error).message.split("\n")[0]})`);
  }

  console.log(`\n✅ E2E passed — merchant #${merchantId}, plan #${planId}, subscription #${subId}`);
}

main().catch((e) => {
  console.error("\n✗ E2E failed:", e instanceof BaseError ? e.shortMessage : e);
  process.exit(1);
});
