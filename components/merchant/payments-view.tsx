"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { usePayments } from "@/hooks/use-api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { QueryError } from "@/components/shared/query-error";
import { PaymentsTable } from "@/components/payments/payments-table";
import { FilterBar, Pagination } from "./form-bits";

const FILTERS = [
  { value: "", label: "All" },
  { value: "succeeded", label: "Paid" },
  { value: "failed", label: "Failed" },
  { value: "refunded", label: "Refunded" },
];

export function PaymentsView() {
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const q = usePayments(status, page);
  const items = q.data?.items ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description="Every collection attempt, with a link to its transaction."
        actions={
          <Button asChild variant="outline" size="sm">
            <a href="/api/payments/export.csv" download>
              <Download aria-hidden /> Export CSV
            </a>
          </Button>
        }
      />
      <FilterBar
        label="Filter by status"
        value={status}
        options={FILTERS}
        onChange={(v) => {
          setStatus(v);
          setPage(1);
        }}
      />
      {q.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
      ) : !items.length ? (
        <EmptyState
          title={status ? "No payments with this status" : "No payments yet"}
          body={status ? "Try another filter." : "Payments show up here once subscribers are charged."}
        />
      ) : (
        <div className={q.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}>
          <div className="rounded-xl border bg-card px-4 md:px-2">
            <PaymentsTable payments={items} columns={["subscriber", "plan"]} />
          </div>
          {q.data ? <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} /> : null}
        </div>
      )}
    </div>
  );
}
