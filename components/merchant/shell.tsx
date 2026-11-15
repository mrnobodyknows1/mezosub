"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, CreditCard, Layers, RefreshCcw, Settings, Users } from "lucide-react";
import { useMerchant } from "@/hooks/use-api";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { MERCHANT_STATUS } from "@/lib/client/status";
import { cn } from "@/lib/client/utils";
import { AuthGate } from "@/components/wallet/auth-gate";
import { WalletButton } from "@/components/wallet/wallet-button";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { QueryError } from "@/components/shared/query-error";
import { StatusBadge } from "@/components/shared/status-badge";
import { Logo } from "@/components/brand/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { Onboarding } from "./onboarding";

const NAV = [
  { href: "/merchant", label: "Overview", icon: BarChart3 },
  { href: "/merchant/plans", label: "Plans", icon: Layers },
  { href: "/merchant/subscribers", label: "Subscribers", icon: Users },
  { href: "/merchant/payments", label: "Payments", icon: CreditCard },
  { href: "/merchant/billing", label: "Billing", icon: RefreshCcw },
  { href: "/merchant/settings", label: "Settings", icon: Settings },
] as const;

function isActive(pathname: string, href: string) {
  return href === "/merchant" ? pathname === "/merchant" : pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ pathname, compact }: { pathname: string; compact?: boolean }) {
  return (
    <ul className={compact ? "flex flex-wrap gap-1" : "space-y-0.5"}>
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <li key={href}>
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-9 items-center gap-2.5 rounded-md px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                active ? "bg-brand-soft font-medium text-brand-ink" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                compact && "px-2.5 text-[0.8125rem]",
              )}
            >
              <Icon className={cn("size-4 shrink-0", compact && "hidden")} strokeWidth={1.75} aria-hidden />
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function TopBar() {
  return (
    <header className="border-b">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link href="/" aria-label="MezoSub home" className="rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <Logo />
        </Link>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

function ShellSkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-10 sm:px-6">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function Dashboard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const merchant = useMerchant();
  // Once onboarding starts it stays on screen until the merchant leaves it (so step 3 can show after registering).
  const [onboarding, setOnboarding] = useState(false);
  const needsOnboarding = merchant.isSuccess && (!merchant.data || merchant.data.chainStatus === "pending");
  if (needsOnboarding && !onboarding) setOnboarding(true);

  if (merchant.isLoading) return <ShellSkeleton />;
  if (merchant.isError) {
    return (
      <div className="mx-auto w-full max-w-xl px-4 py-16">
        <QueryError error={merchant.error} onRetry={() => void merchant.refetch()} title="Couldn't load your merchant profile" />
      </div>
    );
  }
  const m = merchant.data ?? null;
  if (!m || m.chainStatus === "pending" || onboarding) {
    return (
      <div className="flex min-h-dvh flex-col">
        <TopBar />
        <main id="main" className="flex-1">
          <Onboarding merchant={m} onFinish={() => setOnboarding(false)} />
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-surface lg:flex">
        <div className="sticky top-0 flex h-dvh flex-col gap-6 px-3 py-5">
          <Link href="/" aria-label="MezoSub home" className="rounded-md px-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <Logo />
          </Link>
          <nav aria-label="Merchant">
            <NavLinks pathname={pathname} />
          </nav>
          <div className="mt-auto space-y-3 px-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium" title={m.name}>
                {m.name}
              </p>
              <StatusBadge meta={MERCHANT_STATUS[m.chainStatus]} />
            </div>
            <div className="flex items-center gap-1">
              <WalletButton />
              <ThemeToggle />
            </div>
          </div>
        </div>
      </aside>

      <header className="border-b lg:hidden">
        <div className="flex h-14 items-center justify-between gap-2 px-4">
          <Link href="/" aria-label="MezoSub home" className="rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <Logo />
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <WalletButton />
          </div>
        </div>
        <nav aria-label="Merchant" className="px-4 pb-3">
          <NavLinks pathname={pathname} compact />
        </nav>
      </header>

      <main id="main" className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">{children}</div>
      </main>
    </div>
  );
}

export function MerchantShell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const mounted = useMounted();
  if (mounted && auth.signedIn) return <Dashboard>{children}</Dashboard>;
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar />
      <main id="main" className="flex-1">
        <AuthGate title="Sign in to your merchant dashboard" body="Your wallet is your merchant login. Signing in is free and doesn't send a transaction.">
          {null}
        </AuthGate>
      </main>
    </div>
  );
}
