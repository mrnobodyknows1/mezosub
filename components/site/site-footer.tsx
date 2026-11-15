import Link from "next/link";
import { contracts, explorerAddress, isDeployed, MEZO_TESTNET_ID } from "@/lib/chain/config";
import { shortAddress } from "@/lib/client/format";
import { LogoMark } from "@/components/brand/logo";

function ContractLink({ label, address }: { label: string; address: string }) {
  return (
    <li>
      <a
        className="group block hover:text-foreground"
        href={explorerAddress(address)}
        target="_blank"
        rel="noreferrer"
        title={address}
        aria-label={`${label}, ${address}, opens the Mezo explorer`}
      >
        <span className="block">{label}</span>
        <span className="num block font-mono text-xs text-muted-foreground/80 group-hover:text-foreground">{shortAddress(address)}</span>
      </a>
    </li>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 text-sm sm:grid-cols-[1.4fr_1fr_1fr] sm:px-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2 font-semibold">
            <LogoMark className="size-5" /> MezoSub
          </div>
          <p className="max-w-[40ch] text-muted-foreground">Recurring payments, powered by MUSD. Runs on Mezo Testnet (chain {MEZO_TESTNET_ID}). Testnet tokens have no value.</p>
        </div>
        <div className="space-y-2">
          <p className="font-medium">Product</p>
          <ul className="space-y-1.5 text-muted-foreground">
            <li><Link className="hover:text-foreground" href="/merchant">Merchant dashboard</Link></li>
            <li><Link className="hover:text-foreground" href="/account">My subscriptions</Link></li>
            <li><Link className="hover:text-foreground" href="/#how-it-works">How it works</Link></li>
          </ul>
        </div>
        <div className="space-y-2">
          <p className="font-medium">Contracts (Mezo Testnet)</p>
          <ul className="space-y-2.5 text-muted-foreground">
            {isDeployed ? (
              <>
                <ContractLink label="Subscription manager" address={contracts.manager} />
                <ContractLink label="Merchant registry" address={contracts.registry} />
              </>
            ) : (
              <li>Not deployed yet</li>
            )}
            <ContractLink label="MUSD token" address={contracts.musd} />
          </ul>
        </div>
      </div>
    </footer>
  );
}
