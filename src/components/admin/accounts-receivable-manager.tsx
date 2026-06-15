"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Download } from "lucide-react";
import { markCreditReceivablePaidAction } from "@/app/admin/pedidos/actions";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { AdminAccountsReceivableRow, CommercialCreditPaymentReceivedMethod, ReceivablesSummary } from "@/types/credit";
import { formatCurrency } from "@/utils/pricing";

const statusLabels: Record<string, string> = {
  open: "Abierto",
  paid: "Pagado",
  overdue: "Vencido",
};

const paymentReceivedLabels: Record<CommercialCreditPaymentReceivedMethod, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
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
  const [paymentDrafts, setPaymentDrafts] = useState<Record<string, { method: CommercialCreditPaymentReceivedMethod | ""; reference: string }>>({});
  const [isPending, startTransition] = useTransition();
  const visibleRows = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "pending") return rows.filter((row) => row.status !== "paid");
    return rows.filter((row) => row.status === filter);
  }, [filter, rows]);

  function updatePaymentDraft(rowId: string, patch: Partial<{ method: CommercialCreditPaymentReceivedMethod | ""; reference: string }>) {
    setPaymentDrafts((current) => ({
      ...current,
      [rowId]: {
        method: current[rowId]?.method ?? "",
        reference: current[rowId]?.reference ?? "",
        ...patch,
      },
    }));
  }

  function markPaid(row: AdminAccountsReceivableRow) {
    const draft = paymentDrafts[row.id] ?? { method: "", reference: "" };
    if (!draft.method) {
      toast.error("Selecciona el método con el que pagó el cliente.");
      return;
    }
    const paymentMethod = draft.method;

    startTransition(async () => {
      const result = await markCreditReceivablePaidAction({
        receivableId: row.id,
        paymentMethod,
        paymentReference: draft.reference,
      });
      if (result.ok) {
        toast.success(result.message);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
  }

  function exportCsv() {
    const header = ["Cliente", "Pedido", "Factura", "Total", "Saldo", "Creación", "Vencimiento", "Estado", "Método recibido", "Referencia", "Fecha de pago"];
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
        row.payment_received_method ? paymentReceivedLabels[row.payment_received_method] : "",
        row.payment_received_reference ?? "",
        row.paid_at ?? "",
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
            <p className="mt-1 text-sm text-black/55">Pago completo únicamente: cada registro se paga completo o queda abierto.</p>
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
          <table className="w-full min-w-[1120px] text-left text-sm">
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
                <th className="px-3 py-2">Pago recibido</th>
                <th className="px-3 py-2">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {visibleRows.map((row) => {
                const days = daysRemaining(row.due_date);
                const draft = paymentDrafts[row.id] ?? { method: "", reference: "" };
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
                      {row.status === "paid" ? (
                        <div className="space-y-1 text-xs text-black/65">
                          <p className="font-semibold text-black">{row.payment_received_method ? paymentReceivedLabels[row.payment_received_method] : "No registrado"}</p>
                          {row.payment_received_reference ? <p>Referencia: {row.payment_received_reference}</p> : null}
                          <p>Fecha de pago: {row.paid_at ? formatDate(row.paid_at.slice(0, 10)) : "No disponible"}</p>
                        </div>
                      ) : canMarkPaid ? (
                        <div className="grid min-w-56 gap-2">
                          <label className="text-xs font-semibold text-black/55">
                            Método con el que pagó el cliente
                            <select
                              value={draft.method}
                              onChange={(event) =>
                                updatePaymentDraft(row.id, {
                                  method: event.target.value as CommercialCreditPaymentReceivedMethod | "",
                                  reference: event.target.value === "cash" ? "" : draft.reference,
                                })
                              }
                              className="mt-1 w-full rounded-md border border-black/10 bg-white px-2 py-2 text-sm font-normal text-black"
                            >
                              <option value="">Seleccionar</option>
                              <option value="bank_transfer">Transferencia bancaria</option>
                              <option value="card">Tarjeta</option>
                              <option value="cash">Efectivo</option>
                            </select>
                          </label>
                          {draft.method === "bank_transfer" || draft.method === "card" ? (
                            <input
                              value={draft.reference}
                              onChange={(event) => updatePaymentDraft(row.id, { reference: event.target.value })}
                              placeholder={draft.method === "bank_transfer" ? "Número de referencia" : "Referencia / enlace / comprobante"}
                              className="rounded-md border border-black/10 px-2 py-2 text-sm"
                            />
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs text-black/45">Solo lectura</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {canMarkPaid && row.status !== "paid" ? (
                        <Button onClick={() => markPaid(row)} disabled={isPending || !draft.method} variant="primary">
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
                  <td className="px-3 py-6 text-center text-black/55" colSpan={10}>
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
