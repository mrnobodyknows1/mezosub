import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Address, type Hex } from "viem";
import { merchantRegistryAbi, subscriptionManagerAbi } from "@/lib/chain/abis";
import { contracts, type CollectionCheck } from "@/lib/chain/config";
import type { ChainAdapter, ChainBlock, ChainMerchant, ChainPlan, ChainSubscription, RawLog, RawReceipt } from "@/lib/server/chain";
import { decodeLog, type DecodedLog } from "@/lib/server/chain";
import type { KeeperAdapter } from "@/lib/server/keeper";

export const MANAGER = contracts.manager;
export const REGISTRY = contracts.registry;
export const MERCHANT = "0xaaaa00000000000000000000000000000000aaaa" as Address;
export const SUBSCRIBER = "0xbbbb00000000000000000000000000000000bbbb" as Address;
export const KEEPER = "0xcccc00000000000000000000000000000000cccc" as Address;
export const STRANGER = "0xdddd00000000000000000000000000000000dddd" as Address;
export const E18 = 10n ** 18n;

let txCounter = 0;
export const txHash = (label = ""): Hex => keccak256(toHex(`tx-${label}-${++txCounter}`));

type AnyAbi = readonly { type: string; name?: string; inputs?: readonly { name: string; type: string; indexed?: boolean; components?: unknown }[] }[];

/** Build a raw log exactly as an RPC would return it (ABI-encoded topics + data). */
export function rawLog(
  contract: "manager" | "registry",
  eventName: string,
  args: Record<string, unknown>,
  meta: { blockNumber: bigint; txHash: Hex; logIndex: number; blockHash?: Hex; address?: Address },
): RawLog {
  const abi = (contract === "manager" ? subscriptionManagerAbi : merchantRegistryAbi) as unknown as AnyAbi;
  const ev = abi.find((x) => x.type === "event" && x.name === eventName);
  if (!ev) throw new Error(`no event ${eventName}`);
  const indexedArgs: Record<string, unknown> = {};
  for (const i of ev.inputs!) if (i.indexed) indexedArgs[i.name] = args[i.name];
  const topics = (encodeEventTopics as unknown as (a: unknown) => Hex[])({ abi, eventName, args: indexedArgs });
  const nonIndexed = ev.inputs!.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed as never, nonIndexed.map((i) => args[i.name]) as never);
  return {
    address: meta.address ?? (contract === "manager" ? MANAGER : REGISTRY),
    topics,
    data,
    blockNumber: meta.blockNumber,
    blockHash: meta.blockHash ?? blockHashOf(meta.blockNumber, 0),
    transactionHash: meta.txHash,
    logIndex: meta.logIndex,
  };
}

export function decoded(...logs: RawLog[]): DecodedLog[] {
  return logs.map((l) => {
    const d = decodeLog(l);
    if (!d) throw new Error("decode failed");
    return d;
  });
}

export function blockHashOf(n: bigint, fork: number): Hex {
  return keccak256(toHex(`block-${n}-${fork}`));
}

export function chainSub(over: Partial<ChainSubscription> = {}): ChainSubscription {
  return {
    planId: 1n,
    merchantId: 1n,
    subscriber: SUBSCRIBER,
    token: contracts.musd,
    amount: 5n * E18,
    introAmount: 0n,
    introPeriods: 0,
    interval: 300,
    termsVersion: 1,
    remainingCap: 55n * E18,
    expiresAt: 0n,
    nextBillingAt: 0n,
    createdAt: 0n,
    lastPaymentAt: 0n,
    cancelledAt: 0n,
    paymentsCount: 1,
    totalPaid: 5n * E18,
    totalRefunded: 0n,
    status: 1,
    ...over,
  };
}

export function chainPlan(over: Partial<ChainPlan> = {}): ChainPlan {
  return {
    merchantId: 1n,
    token: contracts.musd,
    amount: 5n * E18,
    introAmount: 0n,
    interval: 300,
    trialPeriod: 0,
    introPeriods: 0,
    maxSubscribers: 0,
    activeSubscribers: 0,
    termsVersion: 1,
    status: 1,
    createdAt: 0n,
    ...over,
  };
}

/** In-memory chain. Tests mutate its maps directly. */
export class FakeChain implements ChainAdapter {
  head = 10n;
  fork = new Map<bigint, number>(); // block → fork salt (reorg simulation)
  timestamps = new Map<bigint, bigint>();
  logs: RawLog[] = [];
  receipts = new Map<string, RawReceipt>();
  subs = new Map<bigint, ChainSubscription>();
  plans = new Map<bigint, ChainPlan>();
  merchants = new Map<bigint, ChainMerchant>();
  previews = new Map<bigint, { check: CollectionCheck; amount: bigint }>();
  nonceLatest = 0;
  noncePending = 0;
  failing = new Set<string>(); // method names that throw an RPC error
  smartSigOk = false;
  calls: string[] = [];

  private maybeFail(m: string) {
    this.calls.push(m);
    if (this.failing.has(m)) {
      const e = new Error(`HTTP request failed (${m})`);
      e.name = "HttpRequestError";
      throw e;
    }
  }
  async chainId() {
    return 31611;
  }
  async getBlockNumber() {
    this.maybeFail("getBlockNumber");
    return this.head;
  }
  async getBlock(n: bigint): Promise<ChainBlock> {
    this.maybeFail("getBlock");
    return { number: n, hash: blockHashOf(n, this.fork.get(n) ?? 0), timestamp: this.timestamps.get(n) ?? 1_800_000_000n + n * 5n };
  }
  async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
    this.maybeFail("getLogs");
    return this.logs
      .filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
      .map((l) => ({ ...l, blockHash: blockHashOf(l.blockNumber, this.fork.get(l.blockNumber) ?? 0) }));
  }
  async getReceipt(hash: Hex) {
    this.maybeFail("getReceipt");
    return this.receipts.get(hash.toLowerCase()) ?? null;
  }
  async getSubscription(id: bigint) {
    this.maybeFail("getSubscription");
    const s = this.subs.get(id);
    return s ? { ...s } : chainSub({ status: 0, paymentsCount: 0 });
  }
  async getPlan(id: bigint) {
    this.maybeFail("getPlan");
    const p = this.plans.get(id);
    if (!p) throw new Error("PlanNotFound");
    return { ...p };
  }
  async getMerchant(id: bigint) {
    this.maybeFail("getMerchant");
    const m = this.merchants.get(id);
    if (!m) throw new Error("MerchantNotFound");
    return { ...m };
  }
  async merchantIdOf(owner: Address) {
    for (const [id, m] of this.merchants) if (m.owner.toLowerCase() === owner.toLowerCase()) return id;
    return 0n;
  }
  async previewCollection(id: bigint) {
    this.maybeFail("previewCollection");
    return this.previews.get(id) ?? { check: "not_due" as CollectionCheck, amount: 0n };
  }
  async amountDue(id: bigint) {
    return this.subs.get(id)?.amount ?? 0n;
  }
  async allowance() {
    return 0n;
  }
  async tokenInfo() {
    return { symbol: "MUSD", decimals: 18 };
  }
  async getTransactionCount(_a: Address, tag: "latest" | "pending") {
    this.maybeFail("getTransactionCount");
    return tag === "latest" ? this.nonceLatest : this.noncePending;
  }
  async verifySmartSignature() {
    return this.smartSigOk;
  }

  /** Add a successful receipt (and its logs to the log index) for a tx to `to`. */
  addReceipt(hash: Hex, logs: RawLog[], opts: { to?: Address | null; from?: Address; status?: "success" | "reverted"; blockNumber?: bigint } = {}) {
    const bn = opts.blockNumber ?? logs[0]?.blockNumber ?? this.head;
    const r: RawReceipt = {
      status: opts.status ?? "success",
      to: opts.to === undefined ? MANAGER : opts.to,
      from: opts.from ?? SUBSCRIBER,
      blockNumber: bn,
      blockHash: blockHashOf(bn, this.fork.get(bn) ?? 0),
      transactionHash: hash,
      logs,
    };
    this.receipts.set(hash.toLowerCase(), r);
    if (r.status === "success") this.logs.push(...logs);
    return r;
  }
}

/** Fake keeper: records sends; `onSend` lets a test decide what happens on-chain. */
export class FakeKeeper implements KeeperAdapter {
  address = KEEPER;
  sent: { subId: bigint; nonce: number; replacement: boolean; hash: Hex }[] = [];
  onSend: ((subId: bigint, nonce: number, hash: Hex) => void) | null = null;
  failSend = false;
  async sendCollect(subId: bigint, nonce: number, opts?: { replacement?: boolean }) {
    if (this.failSend) {
      const e = new Error("HTTP request failed (send)");
      e.name = "HttpRequestError";
      throw e;
    }
    const hash = txHash("collect");
    this.sent.push({ subId, nonce, replacement: Boolean(opts?.replacement), hash });
    this.onSend?.(subId, nonce, hash);
    return hash;
  }
  batches: { ids: bigint[]; nonce: number; hash: Hex }[] = [];
  async sendCollectDue(ids: bigint[], nonce: number) {
    const hash = txHash("collectDue");
    this.batches.push({ ids, nonce, hash });
    return hash;
  }
}

/** A session cookie header for an address (inserts the user + session rows). */
export async function sessionCookieFor(address: string): Promise<string> {
  const { getDb } = await import("@/lib/server/db");
  const { ensureUser } = await import("@/lib/server/indexer");
  const { signSessionId, SESSION_COOKIE } = await import("@/lib/server/auth");
  const { randomBytes } = await import("node:crypto");
  const { clock } = await import("@/lib/server/clock");
  const sql = await getDb();
  const userId = await ensureUser(sql, address);
  const id = randomBytes(32).toString("hex");
  await sql`INSERT INTO sessions (id, user_id, address, expires_at) VALUES (${id}, ${userId}, ${address.toLowerCase()}, ${new Date(clock.now().getTime() + 3600_000)})`;
  return `${SESSION_COOKIE}=${signSessionId(id)}`;
}
