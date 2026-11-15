import { encodeFunctionData } from "viem";
import { subscriptionManagerAbi } from "@/lib/chain/abis";
import { MEZO_TESTNET_ID, contracts } from "@/lib/chain/config";
import { requireSession } from "@/lib/server/auth";
import { loadSubscriptionForViewer } from "@/lib/server/access";
import { conflict } from "@/lib/server/errors";
import { route } from "@/lib/server/http";

/**
 * Returns the transaction to sign. Cancellation itself is on-chain only:
 * UI sends {to, data} → waits for the receipt → POST /api/subscriptions/:id/sync {txHash}.
 */
export const POST = route<{ id: string }>(
  async (req, { sql, params }) => {
    const session = await requireSession(sql, req);
    const { row, role } = await loadSubscriptionForViewer(sql, params.id, session.address);
    if (row.status !== "active") throw conflict("not_active", "This subscription is already cancelled");
    const subId = BigInt(String(row.onchain_subscription_id));
    return {
      to: contracts.manager.toLowerCase(),
      data: encodeFunctionData({ abi: subscriptionManagerAbi, functionName: "cancelSubscription", args: [subId] }),
      value: "0",
      chainId: MEZO_TESTNET_ID,
      functionName: "cancelSubscription",
      args: [subId.toString()],
      role,
    };
  },
  { rateLimit: { bucket: "sub_cancel", limit: 20 } },
);
