// FROZEN. Single source of chain + contract configuration. Never hardcode addresses elsewhere.
import { defineChain, type Address } from "viem";

export const MEZO_TESTNET_ID = 31611 as const;

export const mezoTestnet = defineChain({
  id: MEZO_TESTNET_ID,
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_MEZO_RPC_URL || "https://rpc.test.mezo.org"],
      webSocket: ["wss://rpc-ws.test.mezo.org"],
    },
  },
  blockExplorers: { default: { name: "Mezo Explorer", url: "https://explorer.test.mezo.org" } },
  testnet: true,
});

/** Verified live 2026-11-09 on chain 31611: name "Mezo USD", symbol MUSD, 18 decimals, EIP-2612 permit
 *  (DOMAIN_SEPARATOR + nonces present; domain "Mezo USD" / "1"). Listed in the official contracts reference. */
export const MUSD_TESTNET: Address = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503";
export const MUSD_DECIMALS = 18 as const;
export const MUSD_SYMBOL = "MUSD" as const;

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
function addr(v: string | undefined): Address {
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : ZERO;
}

/** Deployed MezoSub contracts. Filled from env after `forge script Deploy` (see contracts/deployments/31611.json). */
export const contracts = {
  musd: addr(process.env.NEXT_PUBLIC_MUSD_ADDRESS) === ZERO ? MUSD_TESTNET : addr(process.env.NEXT_PUBLIC_MUSD_ADDRESS),
  manager: addr(process.env.NEXT_PUBLIC_MANAGER_ADDRESS),
  registry: addr(process.env.NEXT_PUBLIC_REGISTRY_ADDRESS),
  /** Block the contracts were deployed at; the indexer starts here. */
  deployBlock: BigInt(process.env.NEXT_PUBLIC_DEPLOY_BLOCK || "0"),
} as const;

export const isDeployed = contracts.manager !== ZERO && contracts.registry !== ZERO;

export const EXPLORER = "https://explorer.test.mezo.org";
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`;

/** Must match SubscriptionManager. MIN_INTERVAL is an immutable set at deploy (testnet deploy uses 300). */
export const MANAGER_LIMITS = {
  MAX_INTERVAL: 366 * 24 * 3600,
  MAX_BATCH: 50,
  TESTNET_MIN_INTERVAL: 300,
} as const;

/** Billing intervals offered in the UI. Months are fixed 30-day periods (documented in CONTRACTS.md). */
export const BILLING_INTERVALS = {
  weekly: { seconds: 7 * 86400, label: "Weekly", perMonth: 30 / 7 },
  monthly: { seconds: 30 * 86400, label: "Monthly", perMonth: 1 },
  quarterly: { seconds: 91 * 86400, label: "Quarterly", perMonth: 1 / 3 },
  yearly: { seconds: 365 * 86400, label: "Yearly", perMonth: 1 / 12 },
  /** Testnet demonstration only — lets a judge see a renewal without waiting a month. Always labelled in UI. */
  demo_5m: { seconds: 300, label: "Every 5 minutes (testnet demo)", perMonth: (30 * 86400) / 300 },
} as const;
export type BillingIntervalKey = keyof typeof BILLING_INTERVALS;
export function intervalKeyOf(seconds: number): BillingIntervalKey | null {
  for (const [k, v] of Object.entries(BILLING_INTERVALS)) if (v.seconds === seconds) return k as BillingIntervalKey;
  return null;
}

/** On-chain enum order (ISubscriptionManager / IMerchantRegistry). */
export const CHAIN_PLAN_STATUS = ["none", "active", "paused", "archived"] as const;
export const CHAIN_SUB_STATUS = ["none", "active", "cancelled"] as const;
export const CHAIN_MERCHANT_STATUS = ["none", "active", "paused", "suspended"] as const;
export const COLLECTION_CHECK = [
  "ok",
  "not_found",
  "not_active",
  "not_authorized",
  "merchant_inactive",
  "contract_paused",
  "not_due",
  "authorization_expired",
  "spend_cap_exceeded",
  "insufficient_balance",
  "insufficient_allowance",
  "transfer_failed",
] as const;
export type CollectionCheck = (typeof COLLECTION_CHECK)[number];
/** Funding failures are retried by the scheduler; everything else is not retried. */
export const RETRYABLE_CHECKS: readonly CollectionCheck[] = ["insufficient_balance", "insufficient_allowance", "transfer_failed"];

/** Off-chain merchant metadata pointer stored on-chain. */
export const merchantMetadataURI = (merchantUuid: string) => `mezosub:merchant:${merchantUuid}`;

/**
 * Mezo Testnet enforces the EIP-7623 calldata gas floor, and its RPC sometimes returns a gas estimate below that
 * floor (seen live: 21,632 for an MUSD approve that needs ~46k), which the node then rejects. Every sender pads the
 * estimate by 25% and never goes under 60k.
 */
export function paddedGas(estimate: bigint): bigint {
  const padded = (estimate * 125n) / 100n;
  return padded > 60_000n ? padded : 60_000n;
}
