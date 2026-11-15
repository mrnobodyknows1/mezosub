"use client";

import { useState, type ReactNode } from "react";
import { isDeployed } from "@/lib/chain/config";
import { useTx, type UseTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { TxPanel } from "./tx-panel";

/**
 * Confirmation dialog wrapping one on-chain action. Shows what the wallet will ask before it opens,
 * then the shared tx progress. `onConfirm` receives the tx controller and returns true on success.
 */
export function ActionDialog({
  trigger,
  title,
  body,
  walletAsk,
  confirmLabel,
  destructive,
  onConfirm,
  children,
  disabled,
}: {
  trigger: ReactNode;
  title: string;
  body?: ReactNode;
  walletAsk: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: (tx: UseTx) => Promise<boolean | void>;
  children?: ReactNode;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tx = useTx();
  const w = useWallet();
  const done = tx.state.phase === "success" && !tx.state.recordError;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && tx.isBusy) return;
        setOpen(v);
        if (!v) tx.reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {body ? <DialogDescription asChild><div>{body}</div></DialogDescription> : null}
        </DialogHeader>
        {children}
        <TxPanel state={tx.state} description={walletAsk} onRetryRecord={tx.retryRecord} />
        <DialogFooter>
          {done ? (
            <Button onClick={() => setOpen(false)}>Close</Button>
          ) : (
            <>
              <Button variant="ghost" disabled={tx.isBusy} onClick={() => setOpen(false)}>
                Not now
              </Button>
              {w.network.kind === "wrong-network" ? (
                <Button disabled={w.isSwitching} onClick={() => void w.switchToMezo().catch(() => {})}>
                  {w.isSwitching ? "Switching…" : "Switch to Mezo Testnet"}
                </Button>
              ) : (
                <Button
                  variant={destructive ? "destructive" : "default"}
                  disabled={disabled || tx.isBusy || !isDeployed || !w.isConnected}
                  onClick={async () => {
                    const ok = await onConfirm(tx);
                    if (ok === true) setTimeout(() => setOpen(false), 900);
                  }}
                >
                  {tx.isBusy ? "Working…" : !w.isConnected ? "Connect wallet first" : confirmLabel}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
