"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Download } from "lucide-react";
import { markCreditReceivablePaidAction } from "@/app/admin/pedidos/actions";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { AdminAccountsReceivableRow, ReceivablesSummary } from "@/types/credit";
import { formatCurrency } from "@/utils/pricing";

const statusLabels: Record<string, string> = {
  open: "Abierto",
  paid: "Pagado",
  overdue: "Vencido",
};

function formatDate(value: string | null) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-HN", { dateStyle: "medium" }).format(new Date(`${value}T00:00:00-06:00`));
}

function daysRemaining(value: string) {
  const today = new Date();
  const due = new Date(`${value}T00:00:00-06:00`);
  return Math.ceil((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function csvEscape(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function AccountsReceivableManager({
  rows,
  summary,
  canMarkPaid,
  canExport,
}: {
  rows: AdminAccountsReceivableRow[];
  summary: ReceivablesSummary;
  canMarkPaid: boolean;
  canExport: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [filter, setFilter] = useState<"pending" | "all" | "overdue" | "paid">("pending");
  const [isPending, startTransition] = useTransition();
  const visibleRows = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "pending") return rows.filter((row) => row.status !== "paid");
    return rows.filter((row) => row.status === filter);
  }, [filter, rows]);

  function markPaid(row: AdminAccountsReceivableRow) {
    startTransition(async () => {
      const result = await markCreditReceivablePaidAction(row.id);
      if (result.ok) {
        toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  function exportCsv() {
    const header = ["Cliente", "Pedido", "Factura", "Total", "Saldo", "Creación", "Vencimiento", "Estado"];
    const lines = visibleRows.map((row) =>
      [
        row.customer_name,
        row.order_number ?? "",
        row.invoice_number ?? "",
        row.original_amount,
        row.balance_due,
        row.created_at,
        row.due_date,
        statusLabels[row.status] ?? row.status,
      ].map(csvEscape).join(","),
    );
    const blob = new Blob([[header.map(csvEscape).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cuentas-por-cobrar-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <section className="grid gap-3 md:grid-cols-4">
        <Metric label="Total pendiente" value={formatCurrency(summary.totalPending)} />
        <Metric label="Clientes con deuda" value={summary.customersWithDebt.toLocaleString("es-HN")} />
        <Metric label="Vencen en 7 días" value={summary.dueInSevenDays.toLocaleString("es-HN")} />
        <Metric label="Vencidos" value={summary.overdue.toLocaleString("es-HN")} />
      </section>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
          <div>
            <h2 className="font-semibold">Detalle de cuentas por cobrar</h2>
            <p className="mt-1 text-sm text-black/55">Sin pagos parciales: cada registro se paga completo o queda abierto.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["pending", "overdue", "paid", "all"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFilter(option)}
                className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                  filter === option ? "border-[#e4252c] bg-[#fff1f2] text-[#b91c25]" : "border-black/10 bg-white"
                }`}
              >
                {option === "pending" ? "Pendientes" : option === "overdue" ? "Vencidos" : option === "paid" ? "Pagados" : "Todos"}
              </button>
            ))}
            {canExport ? (
              <Button onClick={exportCsv} variant="ghost">
                <Download size={16} />
                Exportar CSV
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-3 py-2">Cliente</th>
                <th className="px-3 py-2">Pedido</th>
                <th className="px-3 py-2">Total</th>
                <th className="px-3 py-2">Saldo</th>
                <th className="px-3 py-2">Creación</th>
                <th className="px-3 py-2">Vencimiento</th>
                <th className="px-3 py-2">Días</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {visibleRows.map((row) => {
                const days = daysRemaining(row.due_date);
                return (
                  <tr key={row.id}>
                    <td className="px-3 py-2">
                      <p className="font-semibold">{row.customer_name}</p>
                      <p className="text-xs text-black/50">{row.customer_phone ?? row.customer_email ?? ""}</p>
                    </td>
                    <td className="px-3 py-2">{row.order_number ?? "Sin pedido"}</td>
                    <td className="px-3 py-2">{formatCurrency(row.original_amount)}</td>
                    <td className="px-3 py-2 font-semibold">{formatCurrency(row.balance_due)}</td>
                    <td className="px-3 py-2">{formatDate(row.created_at.slice(0, 10))}</td>
                    <td className="px-3 py-2">{formatDate(row.due_date)}</td>
                    <td className="px-3 py-2">{row.status === "paid" ? "-" : days < 0 ? `${Math.abs(days)} vencido` : `${days} restantes`}</td>
                    <td className="px-3 py-2">{statusLabels[row.status] ?? row.status}</td>
                    <td className="px-3 py-2">
                      {canMarkPaid && row.status !== "paid" ? (
                        <Button onClick={() => markPaid(row)} disabled={isPending} variant="primary">
                          <CheckCircle2 size={16} />
                          Marcar pagado
                        </Button>
                      ) : (
                        <span className="text-xs text-black/45">Sin acción</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {visibleRows.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-center text-black/55" colSpan={9}>
                    No hay cuentas por cobrar para este filtro.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}
