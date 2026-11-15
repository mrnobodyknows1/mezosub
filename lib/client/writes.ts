import type { Abi, Address, ContractFunctionArgs, ContractFunctionName, Hash, Hex, TransactionReceipt } from "viem";
import type { Config } from "wagmi";
import { getAccount, getPublicClient, simulateContract, waitForTransactionReceipt, writeContract } from "@wagmi/core";
import { erc20Abi, merchantRegistryAbi, subscriptionManagerAbi } from "@/lib/chain/abis";
import { contracts, isDeployed, MEZO_TESTNET_ID, paddedGas } from "@/lib/chain/config";
import type { PlanChainParams } from "@/lib/api-types";
import { assertChain } from "./guard";

/** A single contract write described as data, so it can be previewed, simulated and tested. */
export interface WriteSpec {
  label: string;
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

type Mutating = "nonpayable" | "payable";
function spec<const abi extends Abi, fn extends ContractFunctionName<abi, Mutating>>(
  label: string,
  address: Address,
  abi: abi,
  functionName: fn,
  args: ContractFunctionArgs<abi, Mutating, fn>,
): WriteSpec {
  return { label, address, abi: abi as Abi, functionName, args: args as readonly unknown[] };
}

const M = () => contracts.manager;
const R = () => contracts.registry;

/** PlanChainParams (API, wei strings) → the PlanParams tuple createPlan/updatePlan expect. */
export function toPlanParams(p: PlanChainParams) {
  return {
    token: p.token as Address,
    amount: BigInt(p.amount),
    interval: p.interval,
    trialPeriod: p.trialPeriod,
    introAmount: BigInt(p.introAmount),
    introPeriods: p.introPeriods,
    maxSubscribers: p.maxSubscribers,
  };
}

export const build = {
  // MerchantRegistry
  registerMerchant: (payout: Address, metadataURI: string) =>
    spec("Register as a merchant", R(), merchantRegistryAbi, "registerMerchant", [payout, metadataURI]),
  setPayout: (merchantId: bigint, payout: Address) => spec("Change payout wallet", R(), merchantRegistryAbi, "setPayout", [merchantId, payout]),
  setKeeperEnabled: (merchantId: bigint, enabled: boolean) =>
    spec(enabled ? "Turn on automatic collection" : "Turn off automatic collection", R(), merchantRegistryAbi, "setKeeperEnabled", [merchantId, enabled]),
  pauseMerchant: (merchantId: bigint) => spec("Pause billing", R(), merchantRegistryAbi, "pauseMerchant", [merchantId]),
  resumeMerchant: (merchantId: bigint) => spec("Resume billing", R(), merchantRegistryAbi, "resumeMerchant", [merchantId]),

  // SubscriptionManager: merchant
  createPlan: (p: PlanChainParams) => spec("Publish plan", M(), subscriptionManagerAbi, "createPlan", [toPlanParams(p)]),
  updatePlan: (planId: bigint, p: PlanChainParams) => spec("Update plan terms", M(), subscriptionManagerAbi, "updatePlan", [planId, toPlanParams(p)]),
  pausePlan: (planId: bigint) => spec("Pause plan", M(), subscriptionManagerAbi, "pausePlan", [planId]),
  resumePlan: (planId: bigint) => spec("Resume plan", M(), subscriptionManagerAbi, "resumePlan", [planId]),
  archivePlan: (planId: bigint) => spec("Archive plan", M(), subscriptionManagerAbi, "archivePlan", [planId]),
  refund: (subId: bigint, amount: bigint) => spec("Refund", M(), subscriptionManagerAbi, "refund", [subId, amount]),
  collectPayment: (subId: bigint) => spec("Collect due payment", M(), subscriptionManagerAbi, "collectPayment", [subId]),

  // SubscriptionManager: subscriber
  subscribe: (planId: bigint, termsVersion: number, spendCap: bigint, expiresAt: bigint) =>
    spec("Subscribe", M(), subscriptionManagerAbi, "subscribe", [planId, termsVersion, spendCap, expiresAt]),
  subscribeWithPermit: (
    planId: bigint,
    termsVersion: number,
    spendCap: bigint,
    expiresAt: bigint,
    value: bigint,
    deadline: bigint,
    v: number,
    r: Hex,
    s: Hex,
  ) =>
    spec("Subscribe", M(), subscriptionManagerAbi, "subscribeWithPermit", [planId, termsVersion, spendCap, expiresAt, value, deadline, v, r, s]),
  updateAuthorization: (subId: bigint, newCap: bigint, newExpiresAt: bigint) =>
    spec("Renew authorization", M(), subscriptionManagerAbi, "updateAuthorization", [subId, newCap, newExpiresAt]),
  cancelSubscription: (subId: bigint) => spec("Cancel subscription", M(), subscriptionManagerAbi, "cancelSubscription", [subId]),
  revokeAuthorization: (subId: bigint) => spec("Revoke authorization", M(), subscriptionManagerAbi, "revokeAuthorization", [subId]),

  // MUSD
  approveMusd: (amount: bigint, label = amount === 0n ? "Remove MUSD allowance" : "Allow MUSD spending") =>
    spec(label, contracts.musd, erc20Abi, "approve", [M(), amount]),
};

export interface WriteResult {
  hash: Hash;
  receipt: TransactionReceipt;
}

export class NotDeployedError extends Error {
  constructor() {
    super("MezoSub contracts are not deployed yet.");
    this.name = "NotDeployedError";
  }
}

/** Checks deployment + chain, simulates (so reverts surface before the wallet prompt), sends, waits. */
export async function executeWrite(config: Config, s: WriteSpec, onSubmitted?: (hash: Hash) => void): Promise<WriteResult> {
  if (!isDeployed) throw new NotDeployedError();
  const conn = getAccount(config);
  if (!conn.address) throw new Error("Wallet not connected");
  assertChain(conn.chainId, MEZO_TESTNET_ID);
  const { request } = await simulateContract(config, {
    address: s.address,
    abi: s.abi,
    functionName: s.functionName,
    args: s.args,
    account: conn.address,
    chainId: MEZO_TESTNET_ID,
  } as Parameters<typeof simulateContract>[1]);
  assertChain(getAccount(config).chainId, MEZO_TESTNET_ID);
  // Explicit, padded gas for EOA wallets (see paddedGas). Passport smart accounts build their own transaction.
  let gas: bigint | undefined;
  if (getAccount(config).connector?.type !== "orangekit") {
    const est = await getPublicClient(config, { chainId: MEZO_TESTNET_ID })
      ?.estimateContractGas({ ...(request as object), account: conn.address } as never)
      .catch(() => undefined);
    if (est) gas = paddedGas(est);
  }
  const hash = await writeContract(config, { ...(request as object), ...(gas ? { gas } : {}) } as Parameters<typeof writeContract>[1]);
  onSubmitted?.(hash);
  const receipt = await waitForTransactionReceipt(config, { hash, chainId: MEZO_TESTNET_ID, timeout: 180_000 });
  if (receipt.status !== "success") {
    const err = new Error("The transaction was reverted on-chain.") as Error & { hash: Hash };
    err.hash = hash;
    throw err;
  }
  return { hash, receipt };
}
