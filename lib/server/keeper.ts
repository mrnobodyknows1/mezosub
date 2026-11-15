// Keeper signer. KEEPER_PRIVATE_KEY is read ONLY here, ONLY at call time, and only the worker sets it
// (never configure it on the web deployment). This module is under lib/server and is never imported by client code.

import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { subscriptionManagerAbi } from "@/lib/chain/abis";
import { contracts, mezoTestnet, paddedGas } from "@/lib/chain/config";
import { publicClient } from "./chain";

export interface KeeperAdapter {
  address: Address;
  /** Broadcast collectPayment(subId) with an explicit nonce. `replacement` bumps fees to replace a stuck tx. */
  sendCollect(subscriptionId: bigint, nonce: number, opts?: { replacement?: boolean }): Promise<Hex>;
  /** Broadcast collectDuePayments(ids). Used to release lapsed subscriptions (the batch cancels them on-chain). */
  sendCollectDue?(subscriptionIds: bigint[], nonce: number): Promise<Hex>;
}

let _keeper: KeeperAdapter | null | undefined;
let _override = false;

export function getKeeper(): KeeperAdapter | null {
  if (_override) return _keeper ?? null;
  if (_keeper !== undefined) return _keeper;
  const pk = process.env.KEEPER_PRIVATE_KEY?.trim();
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    _keeper = null;
    return null;
  }
  const account = privateKeyToAccount(pk as Hex);
  const wallet = createWalletClient({
    account,
    chain: mezoTestnet,
    transport: http(process.env.NEXT_PUBLIC_MEZO_RPC_URL || mezoTestnet.rpcUrls.default.http[0], { timeout: 30_000 }),
  });
  _keeper = {
    address: account.address,
    async sendCollect(subscriptionId, nonce, opts) {
      let fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint } = {};
      if (opts?.replacement) {
        // +25% over current estimate is enough to satisfy the 10% replacement rule on geth-style mempools.
        const gp = await publicClient().getGasPrice();
        fees = { gasPrice: (gp * 125n) / 100n };
      }
      const call = { address: contracts.manager, abi: subscriptionManagerAbi, functionName: "collectPayment", args: [subscriptionId] } as const;
      const gas = paddedGas(await publicClient().estimateContractGas({ ...call, account } as never));
      return wallet.writeContract({ ...call, nonce, gas, ...fees } as never);
    },
    async sendCollectDue(subscriptionIds, nonce) {
      const call = { address: contracts.manager, abi: subscriptionManagerAbi, functionName: "collectDuePayments", args: [subscriptionIds] } as const;
      const gas = paddedGas(await publicClient().estimateContractGas({ ...call, account } as never));
      return wallet.writeContract({ ...call, nonce, gas } as never);
    },
  };
  return _keeper;
}

/** Address only (for /api/billing on the web, which has no key): KEEPER_ADDRESS env or the worker heartbeat. */
export function configuredKeeperAddress(): string | null {
  const a = process.env.KEEPER_ADDRESS || process.env.NEXT_PUBLIC_KEEPER_ADDRESS;
  return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
}

export function setKeeperForTests(k: KeeperAdapter | null) {
  _override = true;
  _keeper = k;
}
export function resetKeeperForTests() {
  _override = false;
  _keeper = undefined;
}
