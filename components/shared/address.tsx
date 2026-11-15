"use client";

import { ExternalLink } from "lucide-react";
import { explorerAddress, explorerTx } from "@/lib/chain/config";
import { shortAddress, shortHash } from "@/lib/client/format";
import { cn } from "@/lib/client/utils";
import { CopyButton } from "./copy-button";

export function AddressText({ address, link = true, copy = false, className }: { address: string | null | undefined; link?: boolean; copy?: boolean; className?: string }) {
  if (!address) return <span className="text-muted-foreground">--</span>;
  const body = <span className="font-mono text-[0.8125rem]">{shortAddress(address)}</span>;
  return (
    <span className={cn("inline-flex items-center gap-1", className)} title={address}>
      {link ? (
        <a href={explorerAddress(address)} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
          {body}
          <span className="sr-only"> (open in explorer)</span>
        </a>
      ) : (
        body
      )}
      {copy ? <CopyButton value={address} label="Copy address" /> : null}
    </span>
  );
}

export function TxLink({ hash, label, className }: { hash: string | null | undefined; label?: string; className?: string }) {
  if (!hash) return <span className="text-muted-foreground">--</span>;
  return (
    <a
      href={explorerTx(hash)}
      target="_blank"
      rel="noreferrer"
      className={cn("inline-flex items-center gap-1 text-[0.8125rem] underline-offset-4 hover:underline", className)}
    >
      <span className={label ? undefined : "font-mono"}>{label ?? shortHash(hash)}</span>
      <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden />
      <span className="sr-only">(opens the explorer)</span>
    </a>
  );
}
