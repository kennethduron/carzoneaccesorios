"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Download, History, PlusCircle, ReceiptText, X } from "lucide-react";
import { markCreditReceivablePaidAction, registerCreditReceivablePaymentAction } from "@/app/admin/pedidos/actions";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { AdminAccountsReceivableRow, CommercialCreditPaymentReceivedMethod, ReceivablesSummary } from "@/types/credit";
import { formatCurrency } from "@/utils/pricing";

const statusLabels: Record<string, string> = {
  open: "Abierto",
  partial: "Pago parcial",
  paid: "Pagado",
  overdue: "Vencido",
  cancelled: "Cancelado",
};

const paymentReceivedLabels: Record<CommercialCreditPaymentReceivedMethod, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
};

type PaymentDraft = {
  method: CommercialCreditPaymentReceivedMethod | "";
  reference: string;
};

type PaymentModalDraft = {
  amount: string;
  method: CommercialCreditPaymentReceivedMethod | "";
  reference: string;
  receivedAt: string;
  note: string;
  receiptUrl: string;
  idempotencyKey: string;
};

function formatDate(value: string | null) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-HN", { dateStyle: "medium" }).format(new Date(`${value.slice(0, 10)}T00:00:00-06:00`));
}

function daysRemaining(value: string) {
  const today = new Date();
  const due = new Date(`${value}T00:00:00-06:00`);
  return Math.ceil((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function csvEscape(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function todayInputValue() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function newIdempotencyKey(rowId: string) {
  const randomValue = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `credit-payment:${rowId}:${randomValue}`;
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
  const [filter, setFilter] = useState<"pending" | "all" | "overdue" | "paid" | "partial">("pending");
  const [paymentDrafts, setPaymentDrafts] = useState<Record<string, PaymentDraft>>({});
  const [selectedRow, setSelectedRow] = useState<AdminAccountsReceivableRow | null>(null);
  const [modalDraft, setModalDraft] = useState<PaymentModalDraft | null>(null);
  const [isPending, startTransition] = useTransition();
  const visibleRows = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "pending") return rows.filter((row) => row.status !== "paid" && row.status !== "cancelled");
    return rows.filter((row) => row.status === filter);
  }, [filter, rows]);

  function updatePaymentDraft(rowId: string, patch: Partial<PaymentDraft>) {
    setPaymentDrafts((current) => ({
      ...current,
      [rowId]: {
        method: current[rowId]?.method ?? "",
        reference: current[rowId]?.reference ?? "",
        ...patch,
      },
    }));
  }

  function openPaymentModal(row: AdminAccountsReceivableRow) {
    setSelectedRow(row);
    setModalDraft({
      amount: "",
      method: "",
      reference: "",
      receivedAt: todayInputValue(),
      note: "",
      receiptUrl: "",
      idempotencyKey: newIdempotencyKey(row.id),
    });
  }

  function closePaymentModal() {
    if (isPending) return;
    setSelectedRow(null);
    setModalDraft(null);
  }

  function registerPayment() {
    if (!selectedRow || !modalDraft) return;
    const amount = Math.round(Number(modalDraft.amount) * 100) / 100;

    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("El abono debe ser mayor que cero.");
      return;
    }

    if (amount > selectedRow.balance_due) {
      toast.error("El abono no puede ser mayor que el saldo pendiente de este pedido.");
      return;
    }

    if (!modalDraft.method) {
      toast.error("Selecciona el método de pago del abono.");
      return;
    }

    startTransition(async () => {
      const result = await registerCreditReceivablePaymentAction({
        receivableId: selectedRow.id,
        amount,
        paymentMethod: modalDraft.method as CommercialCreditPaymentReceivedMethod,
        paymentReference: modalDraft.reference,
        receivedAt: modalDraft.receivedAt,
        note: modalDraft.note,
        receiptUrl: modalDraft.receiptUrl,
        idempotencyKey: modalDraft.idempotencyKey,
      });

      if (result.ok) {
        toast.success(result.message);
        setSelectedRow(null);
        setModalDraft(null);
        router.refresh();
      } else {
        toast.error(result.message);
      }
    });
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
    const header = [
      "Cliente",
      "Pedido",
      "Factura",
      "Total original",
      "Total abonado",
      "Saldo pendiente",
      "Creación",
      "Vencimiento",
      "Estado",
      "Método de abono",
      "Referencia",
      "Fecha de abono",
      "Monto de abono",
    ];
    const lines = visibleRows.flatMap((row) => {
      const activePayments = row.payments.filter((payment) => !payment.voided_at);
      const payments = activePayments.length > 0 ? activePayments : [null];
      return payments.map((payment) =>
        [
          row.customer_name,
          row.order_number ?? "",
          row.invoice_number ?? "",
          row.original_amount,
          row.total_paid,
          row.balance_due,
          row.created_at,
          row.due_date,
          statusLabels[row.status],
          payment ? paymentReceivedLabels[payment.payment_method] : "",
          payment?.reference ?? "",
          payment?.received_at ?? "",
          payment?.amount ?? "",
        ].map(csvEscape).join(","),
      );
    });
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
            <p className="mt-1 text-sm text-black/55">Los abonos se registran por pedido y cada saldo se calcula desde su historial.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["pending", "partial", "overdue", "paid", "all"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFilter(option)}
                className={`rounded-md border px-3 py-2 text-sm font-semibold ${
                  filter === option ? "border-[#e4252c] bg-[#fff1f2] text-[#b91c25]" : "border-black/10 bg-white"
                }`}
              >
                {option === "pending" ? "Pendientes" : option === "partial" ? "Pago parcial" : option === "overdue" ? "Vencidos" : option === "paid" ? "Pagados" : "Todos"}
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
          <table className="w-full min-w-[1260px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-3 py-2">Cliente</th>
                <th className="px-3 py-2">Pedido</th>
                <th className="px-3 py-2">Total original</th>
                <th className="px-3 py-2">Abonado</th>
                <th className="px-3 py-2">Saldo</th>
                <th className="px-3 py-2">Vencimiento</th>
                <th className="px-3 py-2">Días</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Historial</th>
                <th className="px-3 py-2">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {visibleRows.map((row) => {
                const days = daysRemaining(row.due_date);
                const draft = paymentDrafts[row.id] ?? { method: "", reference: "" };
                const canCollect = canMarkPaid && row.status !== "paid" && row.status !== "cancelled" && row.balance_due > 0;
                return (
                  <tr key={row.id} className={row.status === "overdue" ? "bg-[#fff7ed]" : undefined}>
                    <td className="px-3 py-3 align-top">
                      <p className="font-semibold">{row.customer_name}</p>
                      <p className="text-xs text-black/50">{row.customer_phone ?? row.customer_email ?? ""}</p>
                    </td>
                    <td className="px-3 py-3 align-top">{row.order_number ?? "Sin pedido"}</td>
                    <td className="px-3 py-3 align-top">{formatCurrency(row.original_amount)}</td>
                    <td className="px-3 py-3 align-top">{formatCurrency(row.total_paid)}</td>
                    <td className="px-3 py-3 align-top font-semibold">{formatCurrency(row.balance_due)}</td>
                    <td className="px-3 py-3 align-top">{formatDate(row.due_date)}</td>
                    <td className="px-3 py-3 align-top">{row.status === "paid" ? "-" : days < 0 ? `${Math.abs(days)} vencido` : `${days} restantes`}</td>
                    <td className="px-3 py-3 align-top">{statusLabels[row.status]}</td>
                    <td className="px-3 py-3 align-top">
                      <PaymentHistory row={row} />
                    </td>
                    <td className="px-3 py-3 align-top">
                      {canCollect ? (
                        <div className="grid min-w-60 gap-2">
                          <Button onClick={() => openPaymentModal(row)} disabled={isPending} variant="ghost">
                            <PlusCircle size={16} />
                            Registrar abono
                          </Button>
                          <label className="text-xs font-semibold text-black/55">
                            Método para marcar pagado
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
                              placeholder={draft.method === "bank_transfer" ? "Número de referencia" : "Referencia / comprobante"}
                              className="rounded-md border border-black/10 px-2 py-2 text-sm"
                            />
                          ) : null}
                          <Button onClick={() => markPaid(row)} disabled={isPending || !draft.method} variant="primary">
                            <CheckCircle2 size={16} />
                            Marcar como pagado
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-black/45">Solo lectura</span>
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

      {selectedRow && modalDraft ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 px-4 py-6">
          <section className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm text-black/50">Pedido {selectedRow.order_number ?? ""}</p>
                <h2 className="mt-1 text-xl font-semibold">Registrar abono</h2>
              </div>
              <button type="button" onClick={closePaymentModal} className="rounded-md border border-black/10 p-2" aria-label="Cerrar">
                <X size={18} />
              </button>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Metric label="Total original" value={formatCurrency(selectedRow.original_amount)} compact />
              <Metric label="Total abonado" value={formatCurrency(selectedRow.total_paid)} compact />
              <Metric label="Saldo pendiente" value={formatCurrency(selectedRow.balance_due)} compact />
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1 text-sm font-semibold">
                Monto
                <input
                  type="number"
                  min="0.01"
                  max={selectedRow.balance_due}
                  step="0.01"
                  value={modalDraft.amount}
                  onChange={(event) => setModalDraft({ ...modalDraft, amount: event.target.value })}
                  className="rounded-md border border-black/10 px-3 py-2 font-normal"
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold">
                Método de pago
                <select
                  value={modalDraft.method}
                  onChange={(event) =>
                    setModalDraft({
                      ...modalDraft,
                      method: event.target.value as CommercialCreditPaymentReceivedMethod | "",
                      reference: event.target.value === "cash" ? "" : modalDraft.reference,
                    })
                  }
                  className="rounded-md border border-black/10 bg-white px-3 py-2 font-normal"
                >
                  <option value="">Seleccionar</option>
                  <option value="bank_transfer">Transferencia bancaria</option>
                  <option value="card">Tarjeta</option>
                  <option value="cash">Efectivo</option>
                </select>
              </label>
              {modalDraft.method !== "cash" ? (
                <label className="grid gap-1 text-sm font-semibold">
                  Referencia
                  <input
                    value={modalDraft.reference}
                    onChange={(event) => setModalDraft({ ...modalDraft, reference: event.target.value })}
                    className="rounded-md border border-black/10 px-3 py-2 font-normal"
                  />
                </label>
              ) : null}
              <label className="grid gap-1 text-sm font-semibold">
                Fecha de recepción
                <input
                  type="date"
                  value={modalDraft.receivedAt}
                  onChange={(event) => setModalDraft({ ...modalDraft, receivedAt: event.target.value })}
                  className="rounded-md border border-black/10 px-3 py-2 font-normal"
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold sm:col-span-2">
                Comprobante opcional
                <input
                  value={modalDraft.receiptUrl}
                  onChange={(event) => setModalDraft({ ...modalDraft, receiptUrl: event.target.value })}
                  placeholder="Enlace del comprobante"
                  className="rounded-md border border-black/10 px-3 py-2 font-normal"
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold sm:col-span-2">
                Nota
                <textarea
                  value={modalDraft.note}
                  onChange={(event) => setModalDraft({ ...modalDraft, note: event.target.value })}
                  rows={3}
                  className="rounded-md border border-black/10 px-3 py-2 font-normal"
                />
              </label>
            </div>

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" onClick={closePaymentModal} variant="ghost" disabled={isPending}>
                Cancelar
              </Button>
              <Button type="button" onClick={registerPayment} variant="primary" disabled={isPending}>
                <ReceiptText size={16} />
                {isPending ? "Registrando..." : "Registrar abono"}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function PaymentHistory({ row }: { row: AdminAccountsReceivableRow }) {
  const activePayments = row.payments.filter((payment) => !payment.voided_at);

  if (activePayments.length === 0) {
    return <span className="text-xs text-black/45">Sin abonos</span>;
  }

  return (
    <div className="min-w-64 space-y-2">
      <p className="inline-flex items-center gap-1 text-xs font-semibold text-black/55">
        <History size={14} />
        {activePayments.length} abono{activePayments.length === 1 ? "" : "s"}
      </p>
      <div className="space-y-1">
        {activePayments.slice(0, 3).map((payment) => (
          <div key={payment.id} className="rounded-md bg-[#f4f4f5] p-2 text-xs">
            <p className="font-semibold">{formatCurrency(payment.amount)}</p>
            <p className="text-black/60">
              {paymentReceivedLabels[payment.payment_method]} · {formatDate(payment.received_at)}
            </p>
            {payment.reference ? <p className="text-black/50">Ref. {payment.reference}</p> : null}
          </div>
        ))}
        {activePayments.length > 3 ? <p className="text-xs text-black/45">Y {activePayments.length - 3} más</p> : null}
      </div>
    </div>
  );
}

function Metric({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className={compact ? "mt-1 text-lg font-semibold" : "mt-1 text-2xl font-semibold"}>{value}</p>
    </div>
  );
}
