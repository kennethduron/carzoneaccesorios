"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Download, PlusCircle, ReceiptText, Search, X } from "lucide-react";
import { markCreditReceivablePaidAction, registerCreditReceivablePaymentAction } from "@/app/admin/pedidos/actions";
import { CreditPaymentHistory } from "@/components/admin/credit-payment-history";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useScrollRestoration } from "@/hooks/use-scroll-restoration";
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

function normalizeSearchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function receivableSearchText(row: AdminAccountsReceivableRow) {
  return normalizeSearchText(
    [
      row.customer_name,
      row.customer_email,
      row.customer_phone,
      row.order_number,
      row.invoice_number,
      statusLabels[row.status],
      row.payment_received_reference,
      row.payment_received_method ? paymentReceivedLabels[row.payment_received_method] : null,
      ...row.payments.flatMap((payment) => [payment.reference, paymentReceivedLabels[payment.payment_method]]),
    ]
      .filter(Boolean)
      .join(" "),
  );
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
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 250);
  const [paymentDrafts, setPaymentDrafts] = useState<Record<string, PaymentDraft>>({});
  const [selectedRow, setSelectedRow] = useState<AdminAccountsReceivableRow | null>(null);
  const [modalDraft, setModalDraft] = useState<PaymentModalDraft | null>(null);
  const [isSubmittingPayment, setIsSubmittingPayment] = useState(false);
  const isSubmittingPaymentRef = useRef(false);
  const [isPending, startTransition] = useTransition();
  const statusRows = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "pending") return rows.filter((row) => row.status !== "paid" && row.status !== "cancelled");
    return rows.filter((row) => row.status === filter);
  }, [filter, rows]);
  const visibleRows = useMemo(() => {
    const normalizedQuery = normalizeSearchText(debouncedQuery.trim());
    if (!normalizedQuery) return statusRows;
    return statusRows.filter((row) => receivableSearchText(row).includes(normalizedQuery));
  }, [debouncedQuery, statusRows]);
  const [scrollContainerRef, saveReceivablesScroll] = useScrollRestoration<HTMLDivElement>(
    "admin:accounts-receivable:scroll",
    `${filter}:${debouncedQuery}:${visibleRows.length}:${rows.length}`,
  );

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
    isSubmittingPaymentRef.current = false;
    setIsSubmittingPayment(false);
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
    if (isPending || isSubmittingPaymentRef.current) return;
    isSubmittingPaymentRef.current = false;
    setIsSubmittingPayment(false);
    setSelectedRow(null);
    setModalDraft(null);
  }

  function registerPayment() {
    if (!selectedRow || !modalDraft) return;
    if (isSubmittingPaymentRef.current) return;
    const amount = Math.round(Number(modalDraft.amount) * 100) / 100;

    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("El abono debe ser mayor que cero.");
      return;
    }

    if (amount > selectedRow.balance_due) {
      toast.error("El abono no puede ser mayor que el saldo pendiente de esta cuenta por cobrar.");
      return;
    }

    if (!modalDraft.method) {
      toast.error("Selecciona el método de pago del abono.");
      return;
    }

    isSubmittingPaymentRef.current = true;
    setIsSubmittingPayment(true);

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
      }).catch(() => ({
        ok: false as const,
        message: "No se pudo registrar el abono. Inténtalo de nuevo.",
      }));

      if (result.ok) {
        toast.success(result.message);
        isSubmittingPaymentRef.current = false;
        setIsSubmittingPayment(false);
        setModalDraft((current) => (current ? { ...current, idempotencyKey: newIdempotencyKey(selectedRow.id) } : current));
        saveReceivablesScroll();
        setSelectedRow(null);
        setModalDraft(null);
        router.refresh();
      } else {
        isSubmittingPaymentRef.current = false;
        setIsSubmittingPayment(false);
        setModalDraft((current) => (current ? { ...current, idempotencyKey: newIdempotencyKey(selectedRow.id) } : current));
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
        saveReceivablesScroll();
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
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Cartera total pendiente" value={formatCurrency(summary.totalPending)} />
        <Metric label="Cartera vencida" value={formatCurrency(summary.overdueBalance)} />
        <Metric label="Cobrado hoy" value={formatCurrency(summary.collectedToday)} />
        <Metric label="Cobrado este mes" value={formatCurrency(summary.collectedThisMonth)} />
        <Metric label="Clientes con deuda" value={summary.customersWithDebt.toLocaleString("es-HN")} />
        <Metric label="Cuentas vencidas" value={summary.overdue.toLocaleString("es-HN")} />
        <Metric label="Vencen en 7 días" value={summary.dueInSevenDays.toLocaleString("es-HN")} />
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-black/10 bg-white p-4">
          <div>
            <h2 className="font-semibold">Próximos vencimientos</h2>
            <p className="mt-1 text-sm text-black/55">Cuentas pendientes ordenadas por fecha de vencimiento.</p>
          </div>
          <div className="mt-3 divide-y divide-black/10">
            {summary.upcomingReceivables.length > 0 ? (
              summary.upcomingReceivables.map((item) => (
                <div key={item.id} className="grid gap-1 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="break-words font-semibold [overflow-wrap:anywhere]">{item.customerName}</p>
                    <p className="text-xs text-black/50">Pedido {item.orderNumber ?? "Sin pedido"} · {formatDate(item.dueDate)}</p>
                  </div>
                  <p className="font-semibold">{formatCurrency(item.balanceDue)}</p>
                </div>
              ))
            ) : (
              <p className="py-3 text-sm text-black/55">No hay próximos vencimientos pendientes.</p>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-4">
          <div>
            <h2 className="font-semibold">Clientes con más deuda</h2>
            <p className="mt-1 text-sm text-black/55">Top 5 por saldo pendiente en crédito comercial.</p>
          </div>
          <div className="mt-3 divide-y divide-black/10">
            {summary.topDebtors.length > 0 ? (
              summary.topDebtors.map((item) => (
                <div key={item.customerId} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <p className="min-w-0 break-words font-semibold [overflow-wrap:anywhere]">{item.customerName}</p>
                  <p className="shrink-0 font-semibold">{formatCurrency(item.balanceDue)}</p>
                </div>
              ))
            ) : (
              <p className="py-3 text-sm text-black/55">No hay clientes con deuda pendiente.</p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-black/10 bg-white p-4">
        <div className="flex flex-col justify-between gap-3 md:flex-row md:items-center">
          <div>
            <h2 className="font-semibold">Detalle de cuentas por cobrar</h2>
            <p className="mt-1 text-sm text-black/55">Los abonos se registran por cuenta por cobrar y cada saldo se calcula desde su historial.</p>
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

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <label className="flex min-w-0 items-center gap-2 rounded-md border border-black/10 px-3 py-2 focus-within:border-[#e4252c] focus-within:ring-2 focus-within:ring-[#e4252c]/15">
            <Search size={18} className="shrink-0 text-black/45" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por cliente, correo, teléfono, pedido, factura, referencia, método o estado"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          {query ? (
            <Button type="button" onClick={() => setQuery("")} variant="ghost">
              <X size={16} />
              Limpiar búsqueda
            </Button>
          ) : null}
        </div>
        <p className="mt-3 text-sm text-black/55">
          Mostrando {visibleRows.length.toLocaleString("es-HN")} de {statusRows.length.toLocaleString("es-HN")} cuentas en este filtro.
        </p>

        <div className="mt-4 grid gap-3 lg:hidden">
          {visibleRows.length === 0 ? (
            <p className="rounded-md border border-black/10 bg-[#f4f4f5] p-4 text-sm text-black/55">No hay cuentas por cobrar para este filtro.</p>
          ) : null}
          {visibleRows.map((row) => {
            const days = daysRemaining(row.due_date);
            const draft = paymentDrafts[row.id] ?? { method: "", reference: "" };
            const canCollect = canMarkPaid && row.status !== "paid" && row.status !== "cancelled" && row.balance_due > 0;
            return (
              <article key={row.id} className={`rounded-lg border border-black/10 p-4 text-sm ${row.status === "overdue" ? "bg-[#fff7ed]" : "bg-white"}`}>
                <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <p className="break-words font-semibold [overflow-wrap:anywhere]">{row.customer_name}</p>
                    <p className="mt-1 text-xs text-black/50">{row.customer_phone ?? row.customer_email ?? "No registrado"}</p>
                    <p className="mt-1 text-xs text-black/50">Pedido {row.order_number ?? "Sin pedido"}</p>
                  </div>
                  <span className="w-fit rounded-md bg-[#f4f4f5] px-2 py-1 text-xs font-semibold">{statusLabels[row.status]}</span>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <MiniInfo label="Total original" value={formatCurrency(row.original_amount)} />
                  <MiniInfo label="Total abonado" value={formatCurrency(row.total_paid)} />
                  <MiniInfo label="Saldo pendiente" value={formatCurrency(row.balance_due)} strong />
                  <MiniInfo label="Vencimiento" value={formatDate(row.due_date)} />
                  <MiniInfo label="Días" value={row.status === "paid" ? "-" : days < 0 ? `${Math.abs(days)} vencido` : `${days} restantes`} />
                  <MiniInfo label="Factura" value={row.invoice_number ?? "Sin factura"} />
                </div>

                <div className="mt-3 rounded-md bg-[#f4f4f5] p-3">
                  <CreditPaymentHistory payments={row.payments} totalPaid={row.total_paid} showRecordedBy balanceDue={row.balance_due} status={row.status} />
                </div>

                <div className="mt-3">
                  <ReceivableActions
                    row={row}
                    draft={draft}
                    canCollect={canCollect}
                    isPending={isPending}
                    isSubmittingPayment={isSubmittingPayment}
                    onOpenPayment={openPaymentModal}
                    onUpdateDraft={updatePaymentDraft}
                    onMarkPaid={markPaid}
                  />
                </div>
              </article>
            );
          })}
        </div>

        <div ref={scrollContainerRef} className="mt-4 hidden lg:block lg:max-h-[calc(100vh-280px)] lg:overflow-auto lg:overscroll-contain">
          <table className="w-full min-w-[1180px] text-left text-sm">
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
                      <p className="text-xs text-black/50">{row.customer_phone ?? row.customer_email ?? "No registrado"}</p>
                    </td>
                    <td className="px-3 py-3 align-top">{row.order_number ?? "Sin pedido"}</td>
                    <td className="px-3 py-3 align-top">{formatCurrency(row.original_amount)}</td>
                    <td className="px-3 py-3 align-top">{formatCurrency(row.total_paid)}</td>
                    <td className="px-3 py-3 align-top font-semibold">{formatCurrency(row.balance_due)}</td>
                    <td className="px-3 py-3 align-top">{formatDate(row.due_date)}</td>
                    <td className="px-3 py-3 align-top">{row.status === "paid" ? "-" : days < 0 ? `${Math.abs(days)} vencido` : `${days} restantes`}</td>
                    <td className="px-3 py-3 align-top">{statusLabels[row.status]}</td>
                    <td className="px-3 py-3 align-top">
                      <CreditPaymentHistory payments={row.payments} totalPaid={row.total_paid} showRecordedBy balanceDue={row.balance_due} status={row.status} />
                    </td>
                    <td className="px-3 py-3 align-top">
                      <ReceivableActions
                        row={row}
                        draft={draft}
                        canCollect={canCollect}
                        isPending={isPending}
                        isSubmittingPayment={isSubmittingPayment}
                        onOpenPayment={openPaymentModal}
                        onUpdateDraft={updatePaymentDraft}
                        onMarkPaid={markPaid}
                      />
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
                <p className="text-sm text-black/50">{selectedRow.order_number ? `Pedido ${selectedRow.order_number}` : selectedRow.invoice_number ? `Factura ${selectedRow.invoice_number}` : "Cuenta histórica"}</p>
                <h2 className="mt-1 text-xl font-semibold">Registrar abono</h2>
              </div>
              <button
                type="button"
                onClick={closePaymentModal}
                disabled={isPending || isSubmittingPayment}
                className="rounded-md border border-black/10 p-2 disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Cerrar"
              >
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
              <Button type="button" onClick={closePaymentModal} variant="ghost" disabled={isPending || isSubmittingPayment}>
                Cancelar
              </Button>
              <Button type="button" onClick={registerPayment} variant="primary" disabled={isPending || isSubmittingPayment}>
                <ReceiptText size={16} />
                {isPending || isSubmittingPayment ? "Registrando..." : "Registrar abono"}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function ReceivableActions({
  row,
  draft,
  canCollect,
  isPending,
  isSubmittingPayment,
  onOpenPayment,
  onUpdateDraft,
  onMarkPaid,
}: {
  row: AdminAccountsReceivableRow;
  draft: PaymentDraft;
  canCollect: boolean;
  isPending: boolean;
  isSubmittingPayment: boolean;
  onOpenPayment: (row: AdminAccountsReceivableRow) => void;
  onUpdateDraft: (rowId: string, patch: Partial<PaymentDraft>) => void;
  onMarkPaid: (row: AdminAccountsReceivableRow) => void;
}) {
  if (!canCollect) {
    return <span className="text-xs text-black/45">Solo lectura</span>;
  }

  return (
    <div className="grid min-w-0 gap-2 lg:min-w-60">
      <Button onClick={() => onOpenPayment(row)} disabled={isPending || isSubmittingPayment} variant="ghost">
        <PlusCircle size={16} />
        Registrar abono
      </Button>
      <label className="text-xs font-semibold text-black/55">
        Método para marcar pagado
        <select
          value={draft.method}
          onChange={(event) =>
            onUpdateDraft(row.id, {
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
          onChange={(event) => onUpdateDraft(row.id, { reference: event.target.value })}
          placeholder={draft.method === "bank_transfer" ? "Número de referencia" : "Referencia / comprobante"}
          className="rounded-md border border-black/10 px-2 py-2 text-sm"
        />
      ) : null}
      <Button onClick={() => onMarkPaid(row)} disabled={isPending || !draft.method} variant="primary">
        <CheckCircle2 size={16} />
        Marcar como pagado
      </Button>
    </div>
  );
}

function MiniInfo({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md bg-[#f4f4f5] px-3 py-2">
      <p className="text-xs uppercase text-black/45">{label}</p>
      <p className={`mt-1 break-words [overflow-wrap:anywhere] ${strong ? "font-semibold" : ""}`}>{value}</p>
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
