"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { toast } from "sonner";
import type { Hash, TransactionReceipt } from "viem";
import { explorerTx } from "@/lib/chain/config";
import { describeTxError, type TxError } from "@/lib/client/errors";
import { executeWrite, type WriteSpec } from "@/lib/client/writes";
import { errorMessage } from "@/lib/client/api";
import { shortHash } from "@/lib/client/format";

/**
 * idle      → nothing started; the UI shows what the wallet will ask
 * wallet    → waiting for the user in their wallet (signature or transaction)
 * submitted → sent, waiting for Mezo Testnet to confirm (hash known)
 * recording → confirmed on-chain, telling MezoSub's API (verify + sync)
 * success   → done
 * error     → failed (decoded reason); recordError means the tx succeeded but syncing failed
 */
export type TxPhase = "idle" | "wallet" | "submitted" | "recording" | "success" | "error";

export interface TxState {
  phase: TxPhase;
  label: string;
  hash?: Hash;
  error?: TxError;
  recordError?: string;
  /** e.g. "Step 1 of 2" */
  progress?: string;
  /** What the wallet is asking for right now: "signature" or "transaction". */
  ask?: "signature" | "transaction";
}

const IDLE: TxState = { phase: "idle", label: "" };

export interface RunOptions {
  /** After the receipt: report the hash to the API (verify + sync). Retried by `retryRecord`. */
  record?: (hash: Hash, receipt: TransactionReceipt) => Promise<unknown>;
  successMessage?: string;
  progress?: string;
  /** No success toast (used for intermediate steps of a sequence). */
  silent?: boolean;
  /** Keep the phase as "wallet" style progress instead of success (intermediate steps). */
  intermediate?: boolean;
}

function ExplorerLink({ hash }: { hash: Hash }) {
  return (
    <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      View {shortHash(hash)} on the explorer
    </a>
  );
}

/**
 * One reusable transaction flow for every on-chain write in MezoSub:
 * wallet prompt → submitted (hash link) → confirmed → POST hash to the API → success.
 * Failures stay visible in `state` (rendered by <TxPanel>) and in a toast, with decoded contract errors.
 */
export function useTx() {
  const config = useConfig();
  const qc = useQueryClient();
  const [state, setState] = useState<TxState>(IDLE);
  const busy = useRef(false);
  const lastRecord = useRef<{ fn: NonNullable<RunOptions["record"]>; hash: Hash; receipt: TransactionReceipt } | null>(null);

  const reset = useCallback(() => {
    if (busy.current) return;
    setState(IDLE);
    lastRecord.current = null;
  }, []);

  const fail = useCallback(
    (label: string, err: unknown, hash?: Hash, progress?: string) => {
      const e = describeTxError(err);
      const failedHash = (err as { hash?: Hash } | null)?.hash ?? hash;
      setState({ phase: "error", label, hash: failedHash, error: e, progress });
      if (e.kind === "rejected") toast.message(e.title, { description: e.message });
      else toast.error(`${label} failed`, { description: e.message });
      void qc.invalidateQueries({ queryKey: ["chain"] });
      return e;
    },
    [qc],
  );

  /** A wallet signature step (e.g. EIP-2612 permit). Throws the decoded TxError on failure. */
  const sign = useCallback(
    async <T,>(label: string, fn: () => Promise<T>, progress?: string): Promise<T> => {
      setState({ phase: "wallet", label, progress, ask: "signature" });
      return fn();
    },
    [],
  );

  const run = useCallback(
    async (s: WriteSpec, opts: RunOptions = {}): Promise<{ hash: Hash; receipt: TransactionReceipt; recorded: boolean } | null> => {
      if (busy.current) return null;
      busy.current = true;
      setState({ phase: "wallet", label: s.label, progress: opts.progress, ask: "transaction" });
      let hash: Hash | undefined;
      try {
        const res = await executeWrite(config, s, (h) => {
          hash = h;
          setState({ phase: "submitted", label: s.label, hash: h, progress: opts.progress });
        });
        hash = res.hash;
        if (opts.record) {
          setState({ phase: "recording", label: s.label, hash, progress: opts.progress });
          lastRecord.current = { fn: opts.record, hash: res.hash, receipt: res.receipt };
          try {
            await opts.record(res.hash, res.receipt);
            lastRecord.current = null;
          } catch (err) {
            const msg = errorMessage(err);
            setState({ phase: "success", label: s.label, hash, recordError: msg, progress: opts.progress });
            toast.warning(`${s.label}: confirmed on-chain, not synced yet`, { description: msg });
            busy.current = false;
            void qc.invalidateQueries();
            return { ...res, recorded: false };
          }
        }
        if (!opts.intermediate) setState({ phase: "success", label: s.label, hash, progress: opts.progress });
        if (!opts.silent) toast.success(opts.successMessage ?? `${s.label}: done`, { description: <ExplorerLink hash={res.hash} /> });
        busy.current = false;
        void qc.invalidateQueries();
        return { ...res, recorded: true };
      } catch (err) {
        busy.current = false;
        fail(s.label, err, hash, opts.progress);
        return null;
      }
    },
    [config, qc, fail],
  );

  const retryRecord = useCallback(async () => {
    const r = lastRecord.current;
    if (!r) return;
    setState((s) => ({ ...s, phase: "recording", recordError: undefined }));
    try {
      await r.fn(r.hash, r.receipt);
      lastRecord.current = null;
      setState((s) => ({ ...s, phase: "success", recordError: undefined }));
      toast.success("Synced");
      void qc.invalidateQueries();
    } catch (err) {
      setState((s) => ({ ...s, phase: "success", recordError: errorMessage(err) }));
    }
  }, [qc]);

  return {
    state,
    run,
    sign,
    fail,
    reset,
    retryRecord,
    setState,
    isBusy: state.phase === "wallet" || state.phase === "submitted" || state.phase === "recording",
  };
}

export type UseTx = ReturnType<typeof useTx>;
