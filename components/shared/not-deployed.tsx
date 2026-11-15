import { isDeployed } from "@/lib/chain/config";
import type { ReactNode } from "react";

/** Replaces on-chain controls with a clear notice when the contracts aren't deployed. */
export function NotDeployedNotice({ className }: { className?: string }) {
  return (
    <div role="status" className={`rounded-lg border border-warn/40 bg-warn/5 px-4 py-3 text-sm ${className ?? ""}`}>
      <p className="font-medium">Contracts not deployed yet</p>
      <p className="mt-0.5 text-muted-foreground">On-chain actions turn on once MezoSub&apos;s contracts are live on Mezo Testnet.</p>
    </div>
  );
}

export function DeployedOnly({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  return <>{isDeployed ? children : (fallback ?? <NotDeployedNotice />)}</>;
}
