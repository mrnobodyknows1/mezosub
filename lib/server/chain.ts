// Chain service. All chain access in the backend goes through the small `ChainAdapter` interface so tests can
// inject fakes (setChainForTests). The live adapter is a viem public client on NEXT_PUBLIC_MEZO_RPC_URL.

import {
  createPublicClient,
  decodeEventLog,
  http,
  verifyMessage,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { erc20Abi, merchantRegistryAbi, subscriptionManagerAbi } from "@/lib/chain/abis";
import { COLLECTION_CHECK, contracts, mezoTestnet, type CollectionCheck } from "@/lib/chain/config";
import { HttpError, unprocessable } from "./errors";

// ---------------------------------------------------------------- types

export interface ChainSubscription {
  planId: bigint;
  merchantId: bigint;
  subscriber: Address;
  token: Address;
  amount: bigint;
  introAmount: bigint;
  introPeriods: number;
  interval: number;
  termsVersion: number;
  remainingCap: bigint;
  expiresAt: bigint;
  nextBillingAt: bigint;
  createdAt: bigint;
  lastPaymentAt: bigint;
  cancelledAt: bigint;
  paymentsCount: number;
  totalPaid: bigint;
  totalRefunded: bigint;
  status: number; // 0 none 1 active 2 cancelled
}

export interface ChainPlan {
  merchantId: bigint;
  token: Address;
  amount: bigint;
  introAmount: bigint;
  interval: number;
  trialPeriod: number;
  introPeriods: number;
  maxSubscribers: number;
  activeSubscribers: number;
  termsVersion: number;
  status: number; // 0 none 1 active 2 paused 3 archived
  createdAt: bigint;
}

export interface ChainMerchant {
  owner: Address;
  payout: Address;
  status: number; // 0 none 1 active 2 paused 3 suspended
  keeperEnabled: boolean;
  createdAt: bigint;
  metadataURI: string;
}

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

export interface RawReceipt {
  status: "success" | "reverted";
  to: Address | null;
  from: Address;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logs: RawLog[];
}

export interface ChainBlock {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

export interface ChainAdapter {
  chainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(n: bigint): Promise<ChainBlock>;
  /** Logs of both MezoSub contracts in [fromBlock, toBlock]. */
  getLogs(range: { fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]>;
  getReceipt(hash: Hex): Promise<RawReceipt | null>;
  getSubscription(id: bigint): Promise<ChainSubscription>;
  getPlan(id: bigint): Promise<ChainPlan>;
  getMerchant(id: bigint): Promise<ChainMerchant>;
  merchantIdOf(owner: Address): Promise<bigint>;
  previewCollection(id: bigint, caller: Address): Promise<{ check: CollectionCheck; amount: bigint }>;
  amountDue(id: bigint): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  tokenInfo(token: Address): Promise<{ symbol: string; decimals: number }>;
  getTransactionCount(address: Address, blockTag: "latest" | "pending"): Promise<number>;
  /** ERC-1271 / ERC-6492 smart-account signature check (EOA handled locally first). */
  verifySmartSignature(address: Address, message: string, signature: Hex): Promise<boolean>;
}

// ---------------------------------------------------------------- decoding

export type ContractKind = "manager" | "registry";

export interface DecodedLog {
  contract: ContractKind;
  eventName: string;
  args: Record<string, unknown>; // bigint values kept as bigint
  blockNumber: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
}

const lc = (a: string | null | undefined) => (a ?? "").toLowerCase();

export function contractKindOf(address: string): ContractKind | null {
  const a = lc(address);
  if (a === lc(contracts.manager)) return "manager";
  if (a === lc(contracts.registry)) return "registry";
  return null;
}

/**
 * Decode a raw log emitted by one of OUR contracts. Logs from any other address return null — a lookalike
 * contract emitting identical event signatures is never trusted.
 */
export function decodeLog(log: RawLog): DecodedLog | null {
  const kind = contractKindOf(log.address);
  if (!kind) return null;
  try {
    const decoded = decodeEventLog({
      abi: kind === "manager" ? subscriptionManagerAbi : merchantRegistryAbi,
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
      strict: true,
    });
    return {
      contract: kind,
      eventName: decoded.eventName as string,
      args: { ...(decoded.args as unknown as Record<string, unknown>) },
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
    };
  } catch {
    return null; // e.g. AccessControl/Pausable events not handled by the indexer, or unknown topic
  }
}

// ---------------------------------------------------------------- receipt verification

export interface VerifyReceiptOptions {
  to: ContractKind;
  /** At least one of these events (emitted by `to`) must be present. */
  events: string[];
  /** Required tx sender (lowercase compare), when an actor matters. */
  from?: string;
  /** Retry window for a receipt that is not yet available. */
  attempts?: number;
  delayMs?: number;
}

export interface VerifiedReceipt {
  receipt: RawReceipt;
  /** All decoded logs of our contracts in the tx (both contracts), log order. */
  logs: DecodedLog[];
  /** The subset matching `events`. */
  matched: DecodedLog[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function verifyReceipt(chain: ChainAdapter, txHash: Hex, opts: VerifyReceiptOptions): Promise<VerifiedReceipt> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new HttpError(400, "invalid_tx_hash", "txHash must be a 32-byte hex string");
  const attempts = opts.attempts ?? 8;
  const delay = opts.delayMs ?? 1500;
  let receipt: RawReceipt | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      receipt = await chain.getReceipt(txHash);
    } catch {
      receipt = null;
    }
    if (receipt) break;
    if (i < attempts - 1) await sleep(Math.min(delay * 2 ** i, 8000));
  }
  if (!receipt) throw new HttpError(404, "tx_not_found", "Transaction receipt not found yet. Try again in a few seconds.");
  if (receipt.status !== "success") throw unprocessable("tx_reverted", "Transaction reverted on-chain");
  const expectedTo = opts.to === "manager" ? contracts.manager : contracts.registry;
  if (lc(receipt.to) !== lc(expectedTo)) {
    throw unprocessable("wrong_contract", "Transaction was not sent to the MezoSub contract", {
      expected: lc(expectedTo),
      actual: lc(receipt.to),
    });
  }
  if (opts.from && lc(receipt.from) !== lc(opts.from)) {
    throw new HttpError(403, "wrong_sender", "Transaction was sent by a different wallet than the signed-in one");
  }
  const logs = receipt.logs.map(decodeLog).filter((l): l is DecodedLog => l !== null);
  const matched = logs.filter((l) => l.contract === opts.to && opts.events.includes(l.eventName));
  if (matched.length === 0) {
    throw unprocessable("event_missing", `Expected event not found in transaction (${opts.events.join(" | ")})`);
  }
  return { receipt, logs, matched };
}

// ---------------------------------------------------------------- live adapter

function asNum(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}
function asBig(v: unknown): bigint {
  return typeof v === "bigint" ? v : BigInt((v as number | string | undefined) ?? 0);
}

export function parseSubscription(r: Record<string, unknown>): ChainSubscription {
  return {
    planId: asBig(r.planId),
    merchantId: asBig(r.merchantId),
    subscriber: r.subscriber as Address,
    token: r.token as Address,
    amount: asBig(r.amount),
    introAmount: asBig(r.introAmount),
    introPeriods: asNum(r.introPeriods),
    interval: asNum(r.interval),
    termsVersion: asNum(r.termsVersion),
    remainingCap: asBig(r.remainingCap),
    expiresAt: asBig(r.expiresAt),
    nextBillingAt: asBig(r.nextBillingAt),
    createdAt: asBig(r.createdAt),
    lastPaymentAt: asBig(r.lastPaymentAt),
    cancelledAt: asBig(r.cancelledAt),
    paymentsCount: asNum(r.paymentsCount),
    totalPaid: asBig(r.totalPaid),
    totalRefunded: asBig(r.totalRefunded),
    status: asNum(r.status),
  };
}

export function parsePlan(r: Record<string, unknown>): ChainPlan {
  return {
    merchantId: asBig(r.merchantId),
    token: r.token as Address,
    amount: asBig(r.amount),
    introAmount: asBig(r.introAmount),
    interval: asNum(r.interval),
    trialPeriod: asNum(r.trialPeriod),
    introPeriods: asNum(r.introPeriods),
    maxSubscribers: asNum(r.maxSubscribers),
    activeSubscribers: asNum(r.activeSubscribers),
    termsVersion: asNum(r.termsVersion),
    status: asNum(r.status),
    createdAt: asBig(r.createdAt),
  };
}

export function parseMerchant(r: Record<string, unknown>): ChainMerchant {
  return {
    owner: r.owner as Address,
    payout: r.payout as Address,
    status: asNum(r.status),
    keeperEnabled: Boolean(r.keeperEnabled),
    createdAt: asBig(r.createdAt),
    metadataURI: String(r.metadataURI ?? ""),
  };
}

let _client: PublicClient | null = null;
export function publicClient(): PublicClient {
  if (!_client) {
    _client = createPublicClient({
      chain: mezoTestnet,
      transport: http(process.env.NEXT_PUBLIC_MEZO_RPC_URL || mezoTestnet.rpcUrls.default.http[0], {
        retryCount: 2,
        timeout: 20_000,
      }),
    }) as PublicClient;
  }
  return _client;
}

function toRawLog(l: {
  address: Address;
  topics: readonly Hex[] | Hex[];
  data: Hex;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  logIndex: number | null;
}): RawLog {
  return {
    address: l.address,
    topics: [...l.topics] as Hex[],
    data: l.data,
    blockNumber: l.blockNumber ?? 0n,
    blockHash: (l.blockHash ?? "0x") as Hex,
    transactionHash: (l.transactionHash ?? "0x") as Hex,
    logIndex: l.logIndex ?? 0,
  };
}

export function createLiveChain(client: PublicClient = publicClient()): ChainAdapter {
  const manager = contracts.manager;
  const registry = contracts.registry;
  return {
    chainId: () => client.getChainId(),
    getBlockNumber: () => client.getBlockNumber(),
    async getBlock(n) {
      const b = await client.getBlock({ blockNumber: n });
      return { number: b.number ?? n, hash: b.hash as Hex, timestamp: b.timestamp };
    },
    async getLogs({ fromBlock, toBlock }) {
      const logs = await client.getLogs({ address: [manager, registry], fromBlock, toBlock });
      return logs.map(toRawLog);
    },
    async getReceipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return {
          status: r.status,
          to: r.to,
          from: r.from,
          blockNumber: r.blockNumber,
          blockHash: r.blockHash,
          transactionHash: r.transactionHash,
          logs: r.logs.map(toRawLog),
        };
      } catch (e) {
        if (e instanceof Error && /could not be found|not found/i.test(e.message)) return null;
        throw e;
      }
    },
    async getSubscription(id) {
      const r = await client.readContract({ address: manager, abi: subscriptionManagerAbi, functionName: "getSubscription", args: [id] });
      return parseSubscription(r as unknown as Record<string, unknown>);
    },
    async getPlan(id) {
      const r = await client.readContract({ address: manager, abi: subscriptionManagerAbi, functionName: "getPlan", args: [id] });
      return parsePlan(r as unknown as Record<string, unknown>);
    },
    async getMerchant(id) {
      const r = await client.readContract({ address: registry, abi: merchantRegistryAbi, functionName: "getMerchant", args: [id] });
      return parseMerchant(r as unknown as Record<string, unknown>);
    },
    async merchantIdOf(owner) {
      return (await client.readContract({ address: registry, abi: merchantRegistryAbi, functionName: "merchantIdOf", args: [owner] })) as bigint;
    },
    async previewCollection(id, caller) {
      const [check, amount] = (await client.readContract({
        address: manager,
        abi: subscriptionManagerAbi,
        functionName: "previewCollection",
        args: [id, caller],
      })) as readonly [number, bigint];
      return { check: COLLECTION_CHECK[Number(check)] ?? "not_found", amount };
    },
    async amountDue(id) {
      return (await client.readContract({ address: manager, abi: subscriptionManagerAbi, functionName: "amountDue", args: [id] })) as bigint;
    },
    async allowance(token, owner, spender) {
      return (await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] })) as bigint;
    },
    async tokenInfo(token) {
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
        client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
      ]);
      return { symbol, decimals: Number(decimals) };
    },
    getTransactionCount: (address, blockTag) => client.getTransactionCount({ address, blockTag }),
    async verifySmartSignature(address, message, signature) {
      try {
        return await client.verifyMessage({ address, message, signature });
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------- singleton + helpers

let _chain: ChainAdapter | null = null;
export function getChain(): ChainAdapter {
  if (!_chain) _chain = createLiveChain();
  return _chain;
}
export function setChainForTests(c: ChainAdapter | null) {
  _chain = c;
}

/** EOA ecrecover first (no network), then ERC-1271/6492 via the RPC for smart accounts. */
export async function verifyWalletSignature(chain: ChainAdapter, address: Address, message: string, signature: Hex): Promise<boolean> {
  try {
    if (await verifyMessage({ address, message, signature })) return true;
  } catch {
    // malformed / non-65-byte signature: fall through to smart-account check
  }
  return chain.verifySmartSignature(address, message, signature);
}

/** Bigint-safe JSON (bigint → decimal string) for chain_events.args. */
export function argsToJson(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "bigint" ? v.toString() : v;
  return out;
}

export function isRpcError(e: unknown): boolean {
  if (!(e instanceof Error)) return true;
  const n = e.name || "";
  return /HttpRequestError|TimeoutError|RpcRequestError|FetchError|SocketClosedError|WebSocketRequestError|InternalRpcError|LimitExceeded/i.test(
    n + " " + e.message,
  );
}
