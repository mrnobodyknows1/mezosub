import type { Address } from "viem";
import type { SubscriberDashboardDTO } from "@/lib/api-types";
import { contracts } from "@/lib/chain/config";
import { requireSession } from "@/lib/server/auth";
import { getChain } from "@/lib/server/chain";
import { paymentSelect, subscriptionSelect, toPaymentDTO, toSubscriptionDTO } from "@/lib/server/dto";
import { route } from "@/lib/server/http";
import { keeperAddressForDisplay } from "@/lib/server/queries";

export const GET = route(async (req, { sql }): Promise<SubscriberDashboardDTO> => {
  const session = await requireSession(sql, req);
  const a = session.address;
  const subs = await sql<Record<string, unknown>>`
    ${subscriptionSelect(sql)} WHERE s.subscriber_address = ${a} ORDER BY (s.status = 'active') DESC, s.created_at DESC LIMIT 200`;
  const keeper = await keeperAddressForDisplay(sql);
  const pays = await sql<Record<string, unknown>>`
    ${paymentSelect(sql)} WHERE s.subscriber_address = ${a} ORDER BY pay.created_at DESC LIMIT 50`;
  const dtos = subs.map(toSubscriptionDTO);
  const committed = dtos.filter((d) => d.status === "active").reduce((acc, d) => acc + BigInt(d.remainingCap), 0n);
  const current = await getChain()
    .allowance(contracts.musd, a as Address, contracts.manager)
    .catch(() => null);
  return {
    subscriptions: dtos,
    payments: pays.map((p) => toPaymentDTO(p, keeper)),
    allowance: {
      tokenAddress: contracts.musd.toLowerCase(),
      spender: contracts.manager.toLowerCase(),
      current: current === null ? "0" : current.toString(),
      committed: committed.toString(),
    },
  };
});
