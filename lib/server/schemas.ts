// zod request schemas for API routes (mirrors lib/api-types.ts request types).
import { z } from "zod";
import { BILLING_INTERVALS, MANAGER_LIMITS } from "@/lib/chain/config";
import { parseMusd } from "@/lib/money";
import { SLUG_RE } from "./slug";

const UINT128_MAX = (1n << 128n) - 1n;
const UINT32_MAX = 4294967295;
const INTERVALS: number[] = Object.values(BILLING_INTERVALS).map((v) => v.seconds);

const httpsUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an https URL");

const nullableHttps = z.union([httpsUrl, z.literal("").transform(() => null), z.null()]).optional();

export const zCreateMerchant = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  logoUrl: nullableHttps,
  website: nullableHttps,
  supportEmail: z.union([z.email().max(200), z.literal("").transform(() => null), z.null()]).optional(),
});

export const zUpdateMerchant = zCreateMerchant.partial().extend({
  webhookUrl: nullableHttps,
  notifyOnPayment: z.boolean().optional(),
  notifyOnFailure: z.boolean().optional(),
});

const humanMusd = z.string().trim().max(60);

export const zCreatePlan = z
  .object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(1000).optional(),
    features: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
    slug: z.string().trim().toLowerCase().regex(SLUG_RE, "3-60 chars, a-z 0-9 and dashes").optional(),
    visibility: z.enum(["public", "unlisted"]).optional(),
    price: humanMusd,
    billingInterval: z.number().int().refine((v) => INTERVALS.includes(v), "unsupported billing interval"),
    trialDays: z.number().int().min(0).max(365).optional(),
    trialSeconds: z.number().int().min(0).max(MANAGER_LIMITS.MAX_INTERVAL).optional(),
    introPrice: humanMusd.optional(),
    introPeriods: z.number().int().min(0).max(24).optional(),
    maxSubscribers: z.number().int().min(0).max(UINT32_MAX).optional(),
  })
  .transform((v, ctx) => {
    const wei = (s: string, path: string) => {
      try {
        return parseMusd(s);
      } catch (e) {
        ctx.addIssue({ code: "custom", path: [path], message: (e as Error).message });
        return 0n;
      }
    };
    const price = wei(v.price, "price");
    if (price <= 0n) ctx.addIssue({ code: "custom", path: ["price"], message: "must be greater than 0" });
    if (price > UINT128_MAX) ctx.addIssue({ code: "custom", path: ["price"], message: "too large" });
    const introPeriods = v.introPeriods ?? 0;
    let introPrice = 0n;
    if (introPeriods > 0) {
      if (!v.introPrice) ctx.addIssue({ code: "custom", path: ["introPrice"], message: "required when introPeriods > 0" });
      else {
        introPrice = wei(v.introPrice, "introPrice");
        if (introPrice <= 0n || introPrice >= price)
          ctx.addIssue({ code: "custom", path: ["introPrice"], message: "must be > 0 and lower than the regular price" });
      }
    } else if (v.introPrice && wei(v.introPrice, "introPrice") !== 0n) {
      ctx.addIssue({ code: "custom", path: ["introPeriods"], message: "introPrice requires introPeriods > 0" });
    }
    const trialSeconds = v.trialSeconds ?? (v.trialDays ?? 0) * 86400;
    if (trialSeconds > MANAGER_LIMITS.MAX_INTERVAL) ctx.addIssue({ code: "custom", path: ["trialDays"], message: "trial too long" });
    return {
      name: v.name,
      description: v.description ?? "",
      features: v.features ?? [],
      slug: v.slug,
      visibility: v.visibility ?? "public",
      price,
      billingInterval: v.billingInterval,
      trialSeconds,
      introPrice,
      introPeriods,
      maxSubscribers: v.maxSubscribers ?? 0,
    };
  });

export const zUpdatePlanMeta = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(1000).optional(),
  features: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
  visibility: z.enum(["public", "unlisted"]).optional(),
});
