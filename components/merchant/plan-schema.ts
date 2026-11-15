import { z } from "zod";
import type { CreatePlanRequest, PlanChainParams, PlanDTO, UpdatePlanMetaRequest } from "@/lib/api-types";
import { BILLING_INTERVALS, intervalKeyOf, type BillingIntervalKey } from "@/lib/chain/config";
import { musdToDecimalString, parseMusd, tryParseMusd } from "@/lib/money";

/** Form values are strings (inputs); converted to API / chain shapes below. Pure, no React. */

export const INTERVAL_KEYS = Object.keys(BILLING_INTERVALS) as BillingIntervalKey[];

const metaShape = {
  name: z.string().trim().min(2, "Use at least 2 characters").max(80, "Keep it under 80 characters"),
  description: z.string().trim().max(1000, "Keep it under 1,000 characters"),
  features: z
    .string()
    .refine((v) => splitFeatures(v).length <= 8, "Up to 8 features")
    .refine((v) => splitFeatures(v).every((f) => f.length <= 120), "Keep each feature under 120 characters"),
  visibility: z.enum(["public", "unlisted"]),
};

const intRe = /^\d+$/;

const termsShape = {
  price: z.string().trim(),
  interval: z.enum(INTERVAL_KEYS as [BillingIntervalKey, ...BillingIntervalKey[]]),
  trial: z.string().trim(),
  introPrice: z.string().trim(),
  introPeriods: z.string().trim(),
  maxSubscribers: z.string().trim(),
};

type TermsInput = { [K in keyof typeof termsShape]: z.infer<(typeof termsShape)[K]> };

function refineTerms(v: TermsInput, ctx: z.RefinementCtx) {
  const price = tryParseMusd(v.price);
  if (price === null || price <= 0n) ctx.addIssue({ code: "custom", path: ["price"], message: "Enter a price above zero, like 9.99" });

  if (v.trial !== "" && !intRe.test(v.trial)) ctx.addIssue({ code: "custom", path: ["trial"], message: "Use a whole number" });
  else if (v.trial !== "") {
    const n = Number(v.trial);
    const max = v.interval === "demo_5m" ? 24 * 60 : 365;
    if (n > max) ctx.addIssue({ code: "custom", path: ["trial"], message: v.interval === "demo_5m" ? "At most 1,440 minutes" : "At most 365 days" });
  }

  const hasIntro = v.introPrice !== "" || (v.introPeriods !== "" && v.introPeriods !== "0");
  if (hasIntro) {
    const intro = tryParseMusd(v.introPrice);
    if (intro === null || intro <= 0n) ctx.addIssue({ code: "custom", path: ["introPrice"], message: "Enter an intro price above zero" });
    else if (price !== null && intro >= price) ctx.addIssue({ code: "custom", path: ["introPrice"], message: "The intro price must be lower than the regular price" });
    if (!intRe.test(v.introPeriods) || Number(v.introPeriods) < 1 || Number(v.introPeriods) > 24)
      ctx.addIssue({ code: "custom", path: ["introPeriods"], message: "Between 1 and 24 payments" });
  }

  if (v.maxSubscribers !== "" && (!intRe.test(v.maxSubscribers) || Number(v.maxSubscribers) > 4_000_000_000))
    ctx.addIssue({ code: "custom", path: ["maxSubscribers"], message: "Use a whole number (0 means no limit)" });
}

export const metaSchema = z.object(metaShape);
export const termsSchema = z.object(termsShape).superRefine(refineTerms);
export const planSchema = z.object({ ...metaShape, ...termsShape }).superRefine(refineTerms);

export type MetaValues = z.infer<typeof metaSchema>;
export type TermsValues = z.infer<typeof termsSchema>;
export type PlanValues = z.infer<typeof planSchema>;

export function splitFeatures(v: string): string[] {
  return v
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function trialSecondsOf(v: Pick<TermsValues, "trial" | "interval">): number {
  const n = v.trial === "" ? 0 : Number(v.trial);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return v.interval === "demo_5m" ? n * 60 : n * 86400;
}

export function hasIntro(v: Pick<TermsValues, "introPrice" | "introPeriods">): boolean {
  return v.introPrice !== "" && v.introPeriods !== "" && Number(v.introPeriods) > 0;
}

export function toCreateRequest(v: PlanValues): CreatePlanRequest {
  const intro = hasIntro(v);
  const trialSeconds = trialSecondsOf(v);
  return {
    name: v.name,
    description: v.description,
    features: splitFeatures(v.features),
    visibility: v.visibility,
    price: v.price,
    billingInterval: BILLING_INTERVALS[v.interval].seconds,
    ...(v.interval === "demo_5m" ? { trialSeconds } : { trialDays: trialSeconds / 86400 }),
    introPrice: intro ? v.introPrice : undefined,
    introPeriods: intro ? Number(v.introPeriods) : 0,
    maxSubscribers: v.maxSubscribers === "" ? 0 : Number(v.maxSubscribers),
  };
}

export function toMetaRequest(v: MetaValues): UpdatePlanMetaRequest {
  return { name: v.name, description: v.description, features: splitFeatures(v.features), visibility: v.visibility };
}

/** Exact updatePlan() args from the terms form (token can't change on-chain). */
export function toChainParams(v: TermsValues, token: string): PlanChainParams {
  const intro = hasIntro(v);
  return {
    token,
    amount: parseMusd(v.price).toString(),
    interval: BILLING_INTERVALS[v.interval].seconds,
    trialPeriod: trialSecondsOf(v),
    introAmount: intro ? parseMusd(v.introPrice).toString() : "0",
    introPeriods: intro ? Number(v.introPeriods) : 0,
    maxSubscribers: v.maxSubscribers === "" ? 0 : Number(v.maxSubscribers),
  };
}

export const EMPTY_PLAN: PlanValues = {
  name: "",
  description: "",
  features: "",
  visibility: "public",
  price: "",
  interval: "monthly",
  trial: "",
  introPrice: "",
  introPeriods: "",
  maxSubscribers: "",
};

export function metaFromPlan(p: PlanDTO): MetaValues {
  return { name: p.name, description: p.description, features: p.features.join("\n"), visibility: p.visibility };
}

export function termsFromPlan(p: PlanDTO): TermsValues {
  const interval = intervalKeyOf(p.billingInterval) ?? "monthly";
  const trial = !p.trialSeconds ? "" : interval === "demo_5m" ? String(Math.round(p.trialSeconds / 60)) : String(Math.round(p.trialSeconds / 86400));
  const intro = p.introPeriods > 0 && p.introPrice !== "0";
  return {
    price: musdToDecimalString(p.price),
    interval,
    trial,
    introPrice: intro ? musdToDecimalString(p.introPrice) : "",
    introPeriods: intro ? String(p.introPeriods) : "",
    maxSubscribers: p.maxSubscribers ? String(p.maxSubscribers) : "",
  };
}

/** True when the terms form differs from what's on the plan. */
export function termsChanged(v: TermsValues, p: PlanDTO): boolean {
  try {
    const a = toChainParams(v, p.tokenAddress);
    return (
      a.amount !== p.price ||
      a.interval !== p.billingInterval ||
      a.trialPeriod !== p.trialSeconds ||
      a.introAmount !== (p.introPeriods > 0 ? p.introPrice : "0") ||
      a.introPeriods !== p.introPeriods ||
      a.maxSubscribers !== p.maxSubscribers
    );
  } catch {
    return true;
  }
}
