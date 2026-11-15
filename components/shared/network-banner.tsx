"use client";

import { toast } from "sonner";
import { isDeployed, MEZO_TESTNET_ID } from "@/lib/chain/config";
import { describeTxError } from "@/lib/client/errors";
import { useMounted } from "@/hooks/use-mounted";
import { useWallet } from "@/hooks/use-wallet";

/** Presentational, so it is unit tested. */
export function WrongNetworkBanner({ chainId, switching, onSwitch }: { chainId: number | undefined; switching?: boolean; onSwitch: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warn/40 bg-warn/10 px-4 py-2 text-[0.8125rem]">
      <span>
        Your wallet is on {chainId ? `network ${chainId}` : "another network"}. MezoSub runs on Mezo Testnet ({MEZO_TESTNET_ID}).
      </span>
      <button
        type="button"
        disabled={switching}
        onClick={onSwitch}
        className="cursor-pointer rounded-sm font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60"
      >
        {switching ? "Switching…" : "Switch to Mezo Testnet"}
      </button>
    </div>
  );
}

export function NotDeployedBanner() {
  return (
    <div role="status" className="border-b border-warn/40 bg-warn/10 px-4 py-2 text-center text-[0.8125rem]">
      Contracts not deployed yet. You can look around, but on-chain actions are turned off.
    </div>
  );
}

/** Global: contracts-not-deployed and wrong-network notices. */
export function NetworkBanner() {
  const mounted = useMounted();
  const w = useWallet();
  if (!isDeployed) return <NotDeployedBanner />;
  if (mounted && w.network.kind === "wrong-network") {
    return (
      <WrongNetworkBanner
        chainId={w.chainId}
        switching={w.isSwitching}
        onSwitch={() =>
          w.switchToMezo().catch((e) => {
            const m = describeTxError(e);
            toast.error(m.title, { description: m.message });
          })
        }
      />
    );
  }
  return null;
}
