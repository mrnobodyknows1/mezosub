import { decodeErrorResult, parseAbi, type Hex } from "viem";
import { erc20Abi, merchantRegistryAbi, subscriptionManagerAbi } from "@/lib/chain/abis";
import type { CollectionCheck } from "@/lib/chain/config";

/**
 * Turns wallet, RPC and contract errors into one plain sentence a person can act on.
 * Custom errors are decoded with the generated ABIs (plus common OpenZeppelin errors); raw hex never reaches the screen.
 */
export type TxErrorKind = "rejected" | "network" | "revert" | "funds" | "rpc" | "unknown";
export interface TxError {
  kind: TxErrorKind;
  title: string;
  message: string;
  errorName?: string;
}

/** OpenZeppelin 5 errors the contracts and MUSD can bubble up (not part of the frozen interfaces). */
const OZ_ERRORS = parseAbi([
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error ReentrancyGuardReentrantCall()",
  "error SafeERC20FailedOperation(address token)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC2612ExpiredSignature(uint256 deadline)",
  "error ERC2612InvalidSigner(address signer, address owner)",
  "error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value)",
]);

/** Plain messages for every custom error a MezoSub user can hit. */
export const ERROR_MESSAGES: Record<string, string> = {
  // SubscriptionManager
  TokenNotAllowed: "This token isn't accepted for subscriptions.",
  InvalidPlanParams: "Those plan terms aren't allowed. Check the price, billing interval, trial and intro price.",
  PlanNotFound: "This plan doesn't exist on-chain.",
  PlanNotActive: "This plan isn't taking new subscribers right now.",
  PlanFull: "This plan has reached its subscriber limit.",
  TermsChanged: "The merchant changed this plan's terms a moment ago. Reload to see the new terms before you subscribe.",
  NotPlanMerchant: "Only the merchant that owns this plan can do that.",
  MerchantNotActive: "This merchant is paused right now, so payments can't go through.",
  NotMerchantOwner: "Only the merchant's owner wallet can do that.",
  AlreadySubscribed: "This wallet already has an active subscription to this plan.",
  InvalidAuthorization: "The spending limit has to cover at least the first payment, and the end date must be in the future.",
  SubscriptionNotFound: "This subscription doesn't exist on-chain.",
  SubscriptionNotActive: "This subscription is cancelled.",
  NotSubscriber: "Only the subscriber's wallet can do that.",
  NotAuthorizedCollector: "This wallet can't collect payments for this merchant.",
  NotDue: "This payment isn't due yet. It may have just been collected.",
  AuthorizationExpired: "The subscriber's authorization has expired. They need to renew it.",
  SpendCapExceeded: "The subscriber's spending limit is used up. They need to renew it.",
  InsufficientBalance: "The subscriber's wallet doesn't hold enough MUSD for this payment.",
  InsufficientAllowance: "The MUSD allowance is too low for this payment. The subscriber needs to increase it.",
  BatchTooLarge: "Too many subscriptions in one batch.",
  RefundTooLarge: "A refund can't be more than what was paid and not yet refunded.",
  ZeroAmount: "The amount must be more than zero.",
  InvalidStatusTransition: "That change isn't possible from the current status. Refresh to see the latest state.",
  // MerchantRegistry
  MerchantNotFound: "This merchant isn't registered on-chain yet.",
  AlreadyRegistered: "This wallet is already registered as a merchant.",
  ZeroAddress: "Enter a valid wallet address.",
  // OpenZeppelin / MUSD
  EnforcedPause: "MezoSub is paused by its operator. New subscriptions and collections are on hold.",
  ExpectedPause: "MezoSub isn't paused.",
  ReentrancyGuardReentrantCall: "Another transaction is in progress. Try again.",
  SafeERC20FailedOperation: "The MUSD transfer failed. Check the balance and allowance.",
  AccessControlUnauthorizedAccount: "This wallet doesn't have permission for this action.",
  AccessControlBadConfirmation: "The role change wasn't confirmed by the right account.",
  InvalidConfig: "The contract settings don't allow this.",
  ERC20InsufficientAllowance: "The MUSD allowance is lower than the amount. Approve a higher amount and retry.",
  ERC20InsufficientBalance: "This wallet doesn't hold enough MUSD.",
  ERC2612ExpiredSignature: "The signature expired. Sign again.",
  ERC2612InvalidSigner: "The signature doesn't match this wallet. Sign again.",
  SafeCastOverflowedUintDowncast: "That amount is too large.",
};

/** Plain explanation + fix for each collection check (used for failure banners). */
export const COLLECTION_REASONS: Record<CollectionCheck, { title: string; fix: string; subscriberFix?: "fund" | "allowance" | "renew" }> = {
  ok: { title: "Ready to collect", fix: "" },
  not_found: { title: "Subscription not found", fix: "Refresh the page." },
  not_active: { title: "Subscription cancelled", fix: "Nothing to collect." },
  not_authorized: { title: "Collector not allowed", fix: "Collect from the merchant wallet, or turn on MezoSub's keeper." },
  merchant_inactive: { title: "Merchant paused", fix: "The merchant needs to resume billing." },
  contract_paused: { title: "MezoSub is paused", fix: "Collections resume when the operator unpauses." },
  not_due: { title: "Not due yet", fix: "It will be collected on the next billing date." },
  authorization_expired: { title: "Authorization expired", fix: "Renew the authorization to keep the subscription going.", subscriberFix: "renew" },
  spend_cap_exceeded: { title: "Spending limit used up", fix: "Renew the authorization with a new limit.", subscriberFix: "renew" },
  insufficient_balance: { title: "Not enough MUSD", fix: "Add MUSD to the wallet, then retry.", subscriberFix: "fund" },
  insufficient_allowance: { title: "Allowance too low", fix: "Increase the MUSD allowance for MezoSub, then retry.", subscriberFix: "allowance" },
  transfer_failed: { title: "Transfer failed", fix: "Check the MUSD balance and allowance, then retry.", subscriberFix: "fund" },
};

export function reasonText(reason: CollectionCheck | null | undefined): string {
  if (!reason) return "Unknown reason";
  return COLLECTION_REASONS[reason]?.title ?? reason;
}

export function messageForError(name: string): string {
  return ERROR_MESSAGES[name] ?? humanizeErrorName(name);
}

/** "SpendCapExceeded" → "Spend cap exceeded." */
export function humanizeErrorName(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/).filter(Boolean);
  if (!words.length) return "The contract rejected this transaction.";
  return `${words.map((w, i) => (i === 0 ? w : w.toLowerCase())).join(" ")}.`;
}

const ALL_ERRORS = [...subscriptionManagerAbi, ...merchantRegistryAbi, ...erc20Abi, ...OZ_ERRORS].filter(
  (x) => (x as { type: string }).type === "error",
);

/** Decode raw revert data with every MezoSub ABI. Returns null when unknown. */
export function decodeRevertData(data: Hex): { errorName: string; args: readonly unknown[] } | null {
  try {
    const r = decodeErrorResult({ abi: ALL_ERRORS as never, data });
    return { errorName: r.errorName, args: (r.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}

type Loose = {
  name?: string;
  code?: number | string;
  message?: string;
  shortMessage?: string;
  details?: string;
  reason?: string;
  data?: unknown;
  raw?: unknown;
  cause?: unknown;
};

function links(err: unknown): Loose[] {
  const out: Loose[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur) && out.length < 12) {
    seen.add(cur);
    out.push(cur as Loose);
    cur = (cur as Loose).cause;
  }
  return out;
}

function text(e: Loose) {
  return [e.shortMessage, e.details, e.message, e.reason].filter((s): s is string => typeof s === "string").join("\n");
}

const revert = (name: string): TxError => ({
  kind: "revert",
  title: "The contract rejected this",
  message: messageForError(name),
  errorName: name,
});

export function describeTxError(err: unknown): TxError {
  if (err == null) return { kind: "unknown", title: "Something went wrong", message: "Please try again." };
  if (typeof err === "string") return { kind: "unknown", title: "Something went wrong", message: err };
  const chain = links(err);

  for (const e of chain) {
    if (e.name === "WrongNetworkError" || e.name === "ChainMismatchError") {
      return { kind: "network", title: "Wrong network", message: "Switch your wallet to Mezo Testnet and try again." };
    }
    if (
      e.name === "UserRejectedRequestError" ||
      e.code === 4001 ||
      e.code === "ACTION_REJECTED" ||
      /user (rejected|denied)|rejected the request|request rejected|denied (transaction|message) signature/i.test(text(e))
    ) {
      return { kind: "rejected", title: "Cancelled in wallet", message: "You cancelled the request. Nothing was sent." };
    }
  }

  for (const e of chain) {
    const d = e.data as { errorName?: string; args?: readonly unknown[] } | undefined;
    if (d && typeof d === "object" && typeof d.errorName === "string") {
      if (d.errorName === "Error" && typeof d.args?.[0] === "string") {
        return { kind: "revert", title: "The contract rejected this", message: d.args[0] };
      }
      if (d.errorName === "Panic") {
        return { kind: "revert", title: "The contract rejected this", message: "The contract hit an internal check." };
      }
      return revert(d.errorName);
    }
    for (const candidate of [e.raw, e.data]) {
      if (typeof candidate === "string" && /^0x[0-9a-fA-F]{8}/.test(candidate)) {
        const dec = decodeRevertData(candidate as Hex);
        if (dec) return revert(dec.errorName);
      }
    }
  }

  const all = chain.map(text).join("\n");
  const hex = /0x[0-9a-fA-F]{8,}/.exec(all);
  if (hex) {
    const dec = decodeRevertData(hex[0] as Hex);
    if (dec) return revert(dec.errorName);
  }
  const named = /(?:reverted with (?:the following )?(?:custom )?(?:error|reason)?:?|Error:)\s*'?([A-Z][A-Za-z0-9]+)\(/.exec(all);
  if (named && ERROR_MESSAGES[named[1]]) return revert(named[1]);

  if (/insufficient funds|exceeds balance|gas required exceeds/i.test(all)) {
    return { kind: "funds", title: "Not enough BTC for gas", message: "Add a little testnet BTC to this wallet to pay network fees." };
  }
  if (/nonce too low|replacement transaction underpriced|already known/i.test(all)) {
    return { kind: "rpc", title: "Another transaction is pending", message: "Wait for your wallet's pending transaction, then retry." };
  }
  if (/timeout|timed out|took too long/i.test(all)) {
    return { kind: "rpc", title: "Network is slow", message: "Mezo Testnet didn't answer in time. Check the explorer before retrying." };
  }
  if (/fetch failed|failed to fetch|network error|HTTP request failed/i.test(all)) {
    return { kind: "rpc", title: "Can't reach Mezo Testnet", message: "Check your connection and retry." };
  }
  if (/chain mismatch|does not match the target chain/i.test(all)) {
    return { kind: "network", title: "Wrong network", message: "Switch your wallet to Mezo Testnet and try again." };
  }
  if (/not connected/i.test(all)) {
    return { kind: "unknown", title: "Wallet not connected", message: "Connect your wallet and try again." };
  }
  if (/method not (found|supported)|does not support|unsupported/i.test(all)) {
    return { kind: "unknown", title: "Not supported by this wallet", message: "Your wallet doesn't support this request." };
  }
  if (/reverted/i.test(all)) {
    return { kind: "revert", title: "The contract rejected this", message: "The transaction was reverted." };
  }
  const first = chain[0];
  const msg = first?.shortMessage || first?.message;
  return { kind: "unknown", title: "Something went wrong", message: msg && msg.length < 160 ? msg : "Please try again." };
}
