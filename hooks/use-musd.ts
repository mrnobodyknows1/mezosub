"use client";

import { useReadContract } from "wagmi";
import type { Address } from "viem";
import { erc20Abi, subscriptionManagerAbi } from "@/lib/chain/abis";
import { contracts, isDeployed, MEZO_TESTNET_ID } from "@/lib/chain/config";

/** Live MUSD balance of `owner` on Mezo Testnet. */
export function useMusdBalance(owner: Address | undefined) {
  return useReadContract({
    address: contracts.musd,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: owner ? [owner] : undefined,
    chainId: MEZO_TESTNET_ID,
    query: { enabled: Boolean(owner), refetchInterval: 15_000 },
  });
}

/** Live MUSD allowance owner → SubscriptionManager. */
export function useMusdAllowance(owner: Address | undefined) {
  return useReadContract({
    address: contracts.musd,
    abi: erc20Abi,
    functionName: "allowance",
    args: owner ? [owner, contracts.manager] : undefined,
    chainId: MEZO_TESTNET_ID,
    query: { enabled: Boolean(owner) && isDeployed, refetchInterval: 15_000 },
  });
}

/** Subscription id of `owner`'s active subscription to an on-chain plan (0n = none). */
export function useActiveSubscriptionOf(planId: bigint | undefined, owner: Address | undefined) {
  return useReadContract({
    address: contracts.manager,
    abi: subscriptionManagerAbi,
    functionName: "activeSubscriptionOf",
    args: planId !== undefined && owner ? [planId, owner] : undefined,
    chainId: MEZO_TESTNET_ID,
    query: { enabled: planId !== undefined && Boolean(owner) && isDeployed },
  });
}

/** Whether this wallet subscribed to the plan before (trial and intro terms then no longer apply). */
export function useHasSubscribed(planId: bigint | undefined, owner: Address | undefined) {
  return useReadContract({
    address: contracts.manager,
    abi: subscriptionManagerAbi,
    functionName: "hasSubscribed",
    args: planId !== undefined && owner ? [planId, owner] : undefined,
    chainId: MEZO_TESTNET_ID,
    query: { enabled: planId !== undefined && Boolean(owner) && isDeployed },
  });
}
