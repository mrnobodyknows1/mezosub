"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { isAddress, type Address } from "viem";
import { TriangleAlert } from "lucide-react";
import type { MerchantDTO, RotateWebhookSecretResponse, UpdateMerchantRequest } from "@/lib/api-types";
import { isDeployed } from "@/lib/chain/config";
import { api, errorMessage } from "@/lib/client/api";
import { shortAddress } from "@/lib/client/format";
import { MERCHANT_STATUS } from "@/lib/client/status";
import { build } from "@/lib/client/writes";
import { qk, useMerchant } from "@/hooks/use-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ActionDialog } from "@/components/shared/action-dialog";
import { AddressText } from "@/components/shared/address";
import { CopyButton } from "@/components/shared/copy-button";
import { NotDeployedNotice } from "@/components/shared/not-deployed";
import { PageHeader, Panel } from "@/components/shared/page-header";
import { QueryError } from "@/components/shared/query-error";
import { StatusBadge } from "@/components/shared/status-badge";
import { Field, inputErrorProps } from "./form-bits";
import { confirmMerchantTx } from "./merchant-api";
import { ProfileForm } from "./onboarding";

async function patchMerchant(qc: ReturnType<typeof useQueryClient>, body: UpdateMerchantRequest) {
  const m = await api<MerchantDTO>("/api/merchants/me", { method: "PATCH", json: body });
  if (m && typeof m === "object" && "id" in m) qc.setQueryData(qk.merchant, m);
  else void qc.invalidateQueries({ queryKey: qk.merchant });
  return m;
}

function PayoutPanel({ merchant }: { merchant: MerchantDTO }) {
  const [next, setNext] = useState("");
  const valid = isAddress(next);
  const same = valid && merchant.payoutAddress?.toLowerCase() === next.toLowerCase();
  const error = next && !valid ? "Enter a valid wallet address (0x…)." : same ? "That's already your payout wallet." : undefined;
  const id = merchant.onchainMerchantId;
  return (
    <Panel title="Payout wallet" description="Where collected MUSD goes. Changes apply to every future payment.">
      <div className="space-y-4">
        <p className="text-sm">
          Current: <AddressText address={merchant.payoutAddress} copy />
        </p>
        {isDeployed && id ? (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <Field id="new-payout" label="New payout wallet" error={error}>
              <Input
                id="new-payout"
                value={next}
                onChange={(e) => setNext(e.target.value.trim())}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-[0.8125rem]"
                {...inputErrorProps("new-payout", error)}
              />
            </Field>
            <ActionDialog
              trigger={
                <Button variant="outline" disabled={!valid || same}>
                  Change payout wallet
                </Button>
              }
              title="Change payout wallet?"
              body={
                <>
                  Future payments go to <span className="font-mono">{shortAddress(next)}</span>. Double-check it: MezoSub can&apos;t move funds sent to a wrong address.
                </>
              }
              walletAsk="Your wallet will send one transaction to update the payout address. You pay a small network fee in BTC."
              confirmLabel="Change wallet"
              onConfirm={async (tx) => {
                const ok = Boolean(
                  await tx.run(build.setPayout(BigInt(id), next as Address), { record: (hash) => confirmMerchantTx(hash), successMessage: "Payout wallet changed" }),
                );
                if (ok) setNext("");
                return ok;
              }}
            />
          </div>
        ) : !isDeployed ? (
          <NotDeployedNotice />
        ) : null}
      </div>
    </Panel>
  );
}

function StatusPanel({ merchant }: { merchant: MerchantDTO }) {
  const id = merchant.onchainMerchantId;
  const paused = merchant.chainStatus === "paused";
  return (
    <Panel title="Billing status">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1 text-sm">
          <StatusBadge meta={MERCHANT_STATUS[merchant.chainStatus]} />
          <p className="max-w-[56ch] text-muted-foreground">
            {merchant.chainStatus === "suspended"
              ? "Your account was suspended by the MezoSub operator. Contact support to resolve it."
              : paused
                ? "No new subscribers and no collections. Subscribers can still cancel."
                : "Pausing stops new subscriptions and all collections until you resume. Subscribers can still cancel."}
          </p>
        </div>
        {!isDeployed ? null : id && merchant.chainStatus === "active" ? (
          <ActionDialog
            trigger={<Button variant="outline">Pause billing</Button>}
            title="Pause billing?"
            body="New people can't subscribe and no payments are collected while paused. Missed periods aren't charged later; billing picks up from the next due date after you resume."
            walletAsk="Your wallet will send one transaction to pause your merchant account. You pay a small network fee in BTC."
            confirmLabel="Pause billing"
            destructive
            onConfirm={async (tx) =>
              Boolean(await tx.run(build.pauseMerchant(BigInt(id)), { record: (hash) => confirmMerchantTx(hash), successMessage: "Billing paused" }))
            }
          />
        ) : id && paused ? (
          <ActionDialog
            trigger={<Button>Resume billing</Button>}
            title="Resume billing?"
            body="New subscribers can join again and due payments can be collected."
            walletAsk="Your wallet will send one transaction to resume your merchant account. You pay a small network fee in BTC."
            confirmLabel="Resume billing"
            onConfirm={async (tx) =>
              Boolean(await tx.run(build.resumeMerchant(BigInt(id)), { record: (hash) => confirmMerchantTx(hash), successMessage: "Billing resumed" }))
            }
          />
        ) : null}
      </div>
    </Panel>
  );
}

function WebhookPanel({ merchant }: { merchant: MerchantDTO }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState(merchant.webhookUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const trimmed = url.trim();
  const error = trimmed && !/^https:\/\/[^\s]+$/i.test(trimmed) ? "Use an https:// URL." : undefined;
  const dirty = trimmed !== (merchant.webhookUrl ?? "");

  async function save() {
    setSaving(true);
    try {
      await patchMerchant(qc, { webhookUrl: trimmed || null });
      toast.success(trimmed ? "Webhook URL saved" : "Webhook removed");
    } catch (e) {
      toast.error("Couldn't save", { description: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    setRotating(true);
    try {
      const r = await api<RotateWebhookSecretResponse>("/api/merchants/me/webhook-secret", { method: "POST", json: {} });
      setSecret(r.secret);
      void qc.invalidateQueries({ queryKey: qk.merchant });
    } catch (e) {
      toast.error("Couldn't create a secret", { description: errorMessage(e) });
    } finally {
      setRotating(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      await api("/api/merchants/me/webhook-test", { method: "POST", json: {} });
      toast.success("Test event queued", { description: "A ping event will arrive at your URL shortly." });
    } catch (e) {
      toast.error("Couldn't send a test", { description: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Panel title="Webhooks" description="Get a signed POST when payments succeed or fail and when subscriptions change.">
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <Field id="webhook" label="Endpoint URL" optional error={error}>
            <Input id="webhook" type="url" inputMode="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} {...inputErrorProps("webhook", error)} />
          </Field>
          <Button variant="outline" onClick={save} disabled={!dirty || Boolean(error) || saving}>
            {saving ? "Saving…" : "Save URL"}
          </Button>
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <p className="font-medium">Signing secret</p>
              <p className="text-muted-foreground">{merchant.hasWebhookSecret ? "Set. Rotating replaces it right away." : "Not set yet."}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={rotate} disabled={rotating}>
                {rotating ? "Creating…" : merchant.hasWebhookSecret ? "Rotate secret" : "Create secret"}
              </Button>
              <Button variant="ghost" size="sm" onClick={test} disabled={testing || !merchant.webhookUrl}>
                {testing ? "Sending…" : "Send test event"}
              </Button>
            </div>
          </div>
          {secret ? (
            <div role="status" className="space-y-2 rounded-lg border border-warn/40 bg-warn/5 p-3 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <TriangleAlert className="size-4 text-warn" aria-hidden /> Copy this secret now. It won&apos;t be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-background px-2 py-1.5 font-mono text-[0.8125rem] ring-1 ring-border">{secret}</code>
                <CopyButton value={secret} label="Copy secret" />
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSecret(null)}>
                I&apos;ve saved it
              </Button>
            </div>
          ) : null}
          <p className="text-[0.8125rem] text-muted-foreground">
            Verify the <code className="font-mono">X-MezoSub-Signature</code> header: an HMAC-SHA256 of <code className="font-mono">{"{t}.{body}"}</code> with your secret.
          </p>
        </div>
      </div>
    </Panel>
  );
}

function NotificationsPanel({ merchant }: { merchant: MerchantDTO }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  async function toggle(key: "notifyOnPayment" | "notifyOnFailure", value: boolean) {
    setPending(key);
    try {
      await patchMerchant(qc, { [key]: value });
    } catch (e) {
      toast.error("Couldn't save", { description: errorMessage(e) });
    } finally {
      setPending(null);
    }
  }
  const rows = [
    { key: "notifyOnPayment" as const, label: "Successful payments", hint: "A note in your dashboard each time a payment is collected." },
    { key: "notifyOnFailure" as const, label: "Failed payments", hint: "When a payment fails or a subscription becomes past due." },
  ];
  return (
    <Panel title="Notifications">
      <ul className="divide-y">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
            <div className="text-sm">
              <Label htmlFor={r.key} className="font-medium">
                {r.label}
              </Label>
              <p className="text-muted-foreground">{r.hint}</p>
            </div>
            <Switch id={r.key} checked={merchant[r.key]} disabled={pending === r.key} onCheckedChange={(v) => void toggle(r.key, v)} />
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function SettingsView() {
  const m = useMerchant();
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Your profile, payouts, billing status and integrations." />
      {m.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-32" />
        </div>
      ) : m.isError ? (
        <QueryError error={m.error} onRetry={() => void m.refetch()} />
      ) : m.data ? (
        <>
          <Panel title="Profile" description="Shown on your checkout pages.">
            <ProfileForm key={m.data.id} merchant={m.data} method="PATCH" submitLabel="Save profile" />
          </Panel>
          <PayoutPanel merchant={m.data} />
          <StatusPanel merchant={m.data} />
          <WebhookPanel key={`wh-${m.data.webhookUrl ?? ""}`} merchant={m.data} />
          <NotificationsPanel merchant={m.data} />
        </>
      ) : null}
    </div>
  );
}
