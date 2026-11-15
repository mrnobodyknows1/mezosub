// Server-side runtime configuration (read lazily so tests and the worker can set process.env first).

const DEFAULT_RETRY = [86400, 172800];
const DEMO_RETRY = [120, 300];

function truthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

export const env = {
  isProd: () => process.env.NODE_ENV === "production",
  demoMode: () => truthy(process.env.BILLING_DEMO_MODE) || truthy(process.env.NEXT_PUBLIC_BILLING_DEMO_MODE),
  /** RETRY_DELAYS_SECONDS (default 24h,48h). BILLING_DEMO_MODE=1 → 120,300. */
  retryDelays(): number[] {
    if (env.demoMode()) return DEMO_RETRY;
    const raw = process.env.RETRY_DELAYS_SECONDS;
    if (!raw) return DEFAULT_RETRY;
    const parsed = raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((n) => Math.floor(n));
    return parsed.length ? parsed : DEFAULT_RETRY;
  },
  confirmations: () => Math.max(0, Number(process.env.CONFIRMATIONS ?? 2) || 0),
  workerIntervalMs: () => Math.max(1000, Number(process.env.WORKER_INTERVAL_MS ?? 15000) || 15000),
  appUrl: () => (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, ""),
  sessionSecret(): string {
    const s = process.env.SESSION_SECRET;
    if (s && s.length >= 32) return s;
    if (env.isProd()) throw new Error("SESSION_SECRET must be set (>= 32 chars) in production");
    return "dev-only-insecure-session-secret-change-me-0000";
  },
  indexerSecret: () => process.env.INDEXER_SECRET || "",
  /** Seconds before a submitted keeper tx with no receipt is considered stuck. */
  txTimeoutSec: () => Math.max(30, Number(process.env.TX_TIMEOUT_SECONDS ?? 180) || 180),
  /** Re-read chain state for all active subscriptions every N indexer passes. */
  reconcileEvery: () => Math.max(1, Number(process.env.RECONCILE_EVERY ?? 20) || 20),
};
