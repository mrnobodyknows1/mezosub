"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type {
  BillingOverviewDTO,
  CheckoutDTO,
  HealthResponse,
  MerchantDTO,
  MerchantOverviewDTO,
  NotificationDTO,
  Paginated,
  PaymentDTO,
  PlanDTO,
  SessionResponse,
  SubscriberDashboardDTO,
  SubscriptionDetailDTO,
  SubscriptionDTO,
} from "@/lib/api-types";
import { api, ApiClientError } from "@/lib/client/api";

/** Accepts T[] or a wrapper ({ items } / { plans } …) so list endpoints stay tolerant. */
export function asList<T>(x: unknown): T[] {
  if (Array.isArray(x)) return x as T[];
  if (x && typeof x === "object") {
    for (const v of Object.values(x as Record<string, unknown>)) if (Array.isArray(v)) return v as T[];
  }
  return [];
}

export const qk = {
  session: ["api", "session"] as const,
  health: ["api", "health"] as const,
  merchant: ["api", "merchant"] as const,
  overview: ["api", "merchant", "overview"] as const,
  plans: ["api", "plans"] as const,
  plan: (id: string) => ["api", "plans", id] as const,
  billing: ["api", "billing"] as const,
  subscriptions: (scope: "merchant" | "subscriber", status: string, page: number) => ["api", "subscriptions", scope, status, page] as const,
  subscription: (id: string) => ["api", "subscription", id] as const,
  payments: (status: string, page: number) => ["api", "payments", status, page] as const,
  mine: ["api", "me", "subscriptions"] as const,
  notifications: ["api", "notifications"] as const,
  checkout: (slug: string) => ["api", "checkout", slug] as const,
};

export function useSession() {
  return useQuery({ queryKey: qk.session, queryFn: () => api<SessionResponse>("/api/auth/session"), staleTime: 60_000 });
}

export function useHealth() {
  return useQuery({ queryKey: qk.health, queryFn: () => api<HealthResponse>("/api/health"), staleTime: 30_000, retry: 1 });
}

/** The signed-in wallet's merchant profile; `null` when none exists yet (API answers 403 "create a profile first", or 404). */
export function useMerchant(enabled = true) {
  return useQuery({
    queryKey: qk.merchant,
    enabled,
    queryFn: async () => {
      try {
        return await api<MerchantDTO>("/api/merchants/me");
      } catch (e) {
        if (e instanceof ApiClientError && (e.status === 404 || e.status === 403)) return null;
        throw e;
      }
    },
  });
}

export function useOverview(enabled = true) {
  return useQuery({
    queryKey: qk.overview,
    enabled,
    queryFn: () => api<MerchantOverviewDTO>("/api/merchants/me/overview"),
    refetchInterval: 30_000,
  });
}

export function usePlans(enabled = true) {
  return useQuery({ queryKey: qk.plans, enabled, queryFn: async () => asList<PlanDTO>(await api<unknown>("/api/plans")) });
}

export function usePlan(id: string | undefined) {
  return useQuery({ queryKey: qk.plan(id ?? ""), enabled: Boolean(id), queryFn: () => api<PlanDTO>(`/api/plans/${id}`) });
}

export function useBilling(enabled = true) {
  return useQuery({
    queryKey: qk.billing,
    enabled,
    queryFn: () => api<BillingOverviewDTO>("/api/billing"),
    refetchInterval: 10_000,
  });
}

export function useSubscriptions(scope: "merchant" | "subscriber", status = "", page = 1, enabled = true) {
  return useQuery({
    queryKey: qk.subscriptions(scope, status, page),
    enabled,
    placeholderData: keepPreviousData,
    queryFn: () => {
      const q = new URLSearchParams({ scope, page: String(page) });
      if (status) q.set("status", status);
      return api<Paginated<SubscriptionDTO>>(`/api/subscriptions?${q}`);
    },
    refetchInterval: 15_000,
  });
}

export function useSubscription(id: string | undefined, poll = 10_000) {
  return useQuery({
    queryKey: qk.subscription(id ?? ""),
    enabled: Boolean(id),
    queryFn: () => api<SubscriptionDetailDTO>(`/api/subscriptions/${id}`),
    refetchInterval: poll,
  });
}

export function usePayments(status = "", page = 1, enabled = true) {
  return useQuery({
    queryKey: qk.payments(status, page),
    enabled,
    placeholderData: keepPreviousData,
    queryFn: () => {
      const q = new URLSearchParams({ page: String(page) });
      if (status) q.set("status", status);
      return api<Paginated<PaymentDTO>>(`/api/payments?${q}`);
    },
    refetchInterval: 15_000,
  });
}

export function useMySubscriptions(enabled = true) {
  return useQuery({
    queryKey: qk.mine,
    enabled,
    queryFn: () => api<SubscriberDashboardDTO>("/api/me/subscriptions"),
    refetchInterval: 15_000,
  });
}

export function useNotifications(enabled = true) {
  return useQuery({
    queryKey: qk.notifications,
    enabled,
    queryFn: async () => asList<NotificationDTO>(await api<unknown>("/api/notifications")),
    refetchInterval: 30_000,
  });
}

export function useCheckout(slug: string) {
  return useQuery({ queryKey: qk.checkout(slug), queryFn: () => api<CheckoutDTO>(`/api/public/plans/${encodeURIComponent(slug)}`), staleTime: 15_000 });
}
