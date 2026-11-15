"use client";

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { describeTxError } from "@/lib/client/errors";
import { shortAddress } from "@/lib/client/format";
import { useMounted } from "@/hooks/use-mounted";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectDialog } from "./connect-dialog";

/** Step list shown while signing in. */
function Steps({ step }: { step: 1 | 2 }) {
  const items = ["Connect your wallet", "Sign in with a free signature"];
  return (
    <ol className="mt-6 space-y-2 text-sm">
      {items.map((t, i) => (
        <li key={t} className="flex items-center gap-3">
          <span
            className={`num flex size-6 items-center justify-center rounded-full text-xs font-medium ${i + 1 < step ? "bg-brand text-brand-foreground" : i + 1 === step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
          >
            {i + 1}
          </span>
          <span className={i + 1 === step ? "font-medium" : "text-muted-foreground"}>{t}</span>
        </li>
      ))}
    </ol>
  );
}

/** Renders children only for a signed-in wallet; otherwise walks the user through connect → sign. */
export function AuthGate({ children, title = "Sign in to continue", body }: { children: ReactNode; title?: string; body?: string }) {
  const mounted = useMounted();
  const auth = useAuth();
  const w = auth.wallet;
  const [open, setOpen] = useState(false);

  if (!mounted || auth.sessionLoading) {
    return (
      <div className="mx-auto w-full max-w-md space-y-3 px-4 py-16">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-9 w-40" />
      </div>
    );
  }
  if (auth.signedIn) return <>{children}</>;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-16 sm:py-24">
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {body ?? "Your wallet is your login. Signing in is free and doesn't send a transaction."}
      </p>
      <Steps step={w.isConnected ? 2 : 1} />
      <div className="mt-6 space-y-3">
        {!w.isConnected ? (
          <>
            <Button onClick={() => setOpen(true)}>Connect wallet</Button>
            <ConnectDialog open={open} onOpenChange={setOpen} />
          </>
        ) : w.network.kind === "wrong-network" ? (
          <Button disabled={w.isSwitching} onClick={() => w.switchToMezo().catch((e) => toast.error(describeTxError(e).message))}>
            {w.isSwitching ? "Switching…" : "Switch to Mezo Testnet"}
          </Button>
        ) : (
          <>
            <Button
              disabled={auth.signIn.isPending}
              onClick={() => auth.signIn.mutate(undefined, { onError: (e) => toast.error("Sign-in failed", { description: describeTxError(e).message }) })}
            >
              {auth.signIn.isPending ? "Check your wallet…" : "Sign in"}
            </Button>
            <p className="text-[0.8125rem] text-muted-foreground">
              Connected as <span className="font-mono">{shortAddress(w.address)}</span>
              {auth.mismatch ? ". You were signed in with a different wallet." : "."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
