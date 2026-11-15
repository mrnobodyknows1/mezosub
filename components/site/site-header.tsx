import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { WalletButton } from "@/components/wallet/wallet-button";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-[var(--z-sticky)] border-b bg-background/95 supports-[backdrop-filter]:bg-background/85 supports-[backdrop-filter]:backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label="MezoSub home">
          <Logo />
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1 sm:gap-2">
          <Link href="/#how-it-works" className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground md:inline-block">
            How it works
          </Link>
          <Link href="/account" className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground sm:inline-block">
            My subscriptions
          </Link>
          <Link href="/merchant" className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground sm:inline-block">
            For merchants
          </Link>
          <ThemeToggle />
          <WalletButton />
        </nav>
      </div>
    </header>
  );
}
