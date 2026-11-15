// Test fixtures only. Never imported by app code.
import type { CheckoutDTO } from "@/lib/api-types";

const MUSD = 10n ** 18n;
export const wei = (n: number | bigint) => (BigInt(n) * MUSD).toString();

export function checkoutFixture(over: Partial<CheckoutDTO["plan"]> = {}): CheckoutDTO {
  return {
    plan: {
      id: "11111111-1111-1111-1111-111111111111",
      merchantId: "22222222-2222-2222-2222-222222222222",
      onchainPlanId: "7",
      slug: "studio-pro",
      name: "Studio Pro",
      description: "Monthly access to the studio toolkit.",
      features: ["Unlimited projects", "Priority support"],
      visibility: "public",
      status: "active",
      checkoutUrl: "http://localhost:3000/subscribe/studio-pro",
      activeSubscribers: 4,
      mrr: wei(48),
      createTxHash: "0x" + "ab".repeat(32),
      createdAt: "2026-11-01T10:00:00.000Z",
      tokenAddress: "0x118917a40faf1cd7a13db0ef56c86de7973ac503",
      tokenSymbol: "MUSD",
      tokenDecimals: 18,
      price: wei(12),
      billingInterval: 30 * 86400,
      intervalLabel: "Monthly",
      trialSeconds: 0,
      introPrice: "0",
      introPeriods: 0,
      maxSubscribers: 0,
      termsVersion: 3,
      ...over,
    },
    merchant: {
      id: "22222222-2222-2222-2222-222222222222",
      name: "Lumen Studio",
      slug: "lumen-studio",
      description: "Design tools.",
      logoUrl: null,
      website: "https://lumen.example",
      supportEmail: "help@lumen.example",
      walletAddress: "0x1111111111111111111111111111111111111111",
      payoutAddress: "0x2222222222222222222222222222222222222222",
      chainStatus: "active",
    },
    managerAddress: "0x3333333333333333333333333333333333333333",
    chainId: 31611,
    live: { planStatus: "active", termsVersion: 3, activeSubscribers: 4, acceptingSubscribers: true, reason: null },
    firstCharge: { amount: wei(12), at: "2026-11-09T12:00:00.000Z" },
    secondCharge: { amount: wei(12), at: "2026-12-09T12:00:00.000Z" },
    suggestedSpendCap: wei(144),
    suggestedPeriods: 12,
  };
}
