"use client";

import { useMemo, useState } from "react";
import { History, X } from "lucide-react";
import { Button } from "@/components/ui";
import type { AccountsReceivablePaymentRow } from "@/types/credit";
import { formatHnDateTime } from "@/utils/format";
import { formatCurrency } from "@/utils/pricing";

const paymentMethodLabels: Record<string, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
};

const statusLabels: Record<string, string> = {
  open: "Abierto",
  partial: "Pago parcial",
  paid: "Pagado",
  overdue: "Vencido",
  cancelled: "Cancelado",
};

type CreditPaymentHistoryProps = {
  payments: AccountsReceivablePaymentRow[];
  totalPaid: number;
  showRecordedBy: boolean;
  compact?: boolean;
  currency?: string;
  balanceDue?: number;
  status?: string;
  showNotes?: boolean;
};

function paymentDate(payment: Pick<AccountsReceivablePaymentRow, "received_at" | "created_at">) {
  return formatHnDateTime(payment.received_at ?? payment.created_at);
}

function recorderLabel(payment: Pick<AccountsReceivablePaymentRow, "recorded_by_name" | "recorded_by_email">) {
  return payment.recorded_by_name ?? payment.recorded_by_email ?? "Usuario interno";
}

function paymentTime(payment: Pick<AccountsReceivablePaymentRow, "received_at" | "created_at">) {
  return new Date(payment.received_at ?? payment.created_at).getTime();
}

export function CreditPaymentHistory({
  payments,
  totalPaid,
  showRecordedBy,
  compact = true,
  currency = "HNL",
  balanceDue,
  status,
  showNotes = true,
}: CreditPaymentHistoryProps) {
  const [open, setOpen] = useState(false);
  const activePayments = useMemo(
    () => payments.filter((payment) => !payment.voided_at).sort((left, right) => paymentTime(right) - paymentTime(left)),
    [payments],
  );
  const latestPayment = activePayments[0] ?? null;

  if (activePayments.length === 0) {
    return <span className="text-xs text-black/45">Sin abonos</span>;
  }

  return (
    <div className={compact ? "min-w-0 space-y-2 text-xs" : "space-y-3 text-sm"}>
      <div className="space-y-1">
        <p className="inline-flex items-center gap-1 font-semibold text-black/65">
          <History size={14} />
          {activePayments.length} abono{activePayments.length === 1 ? "" : "s"}
        </p>
        <span className="sr-only">Moneda: {currency}</span>
        <p className="text-black/55">Total abonado: {formatCurrency(totalPaid)}</p>
        {latestPayment ? (
          <p className="leading-5 text-black/60">
            Último: {formatCurrency(latestPayment.amount)} · {paymentMethodLabels[latestPayment.payment_method] ?? "Abono"} · {paymentDate(latestPayment)}
          </p>
        ) : null}
      </div>
      <Button type="button" variant="ghost" onClick={() => setOpen(true)} className="px-3 py-1.5 text-xs">
        Ver historial
      </Button>

      {open ? (
        <div className="cz-layer-modal fixed inset-0 z-[80] grid place-items-center bg-black/45 px-4 py-6">
          <section className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white p-5 text-[#080808] shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm text-black/50">Abonos</p>
                <h2 className="mt-1 text-xl font-semibold">Historial de abonos</h2>
                <p className="mt-1 text-sm text-black/55">
                  {activePayments.length} abono{activePayments.length === 1 ? "" : "s"} · Total abonado: {formatCurrency(totalPaid)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-black/10 p-2"
                aria-label="Cerrar historial de abonos"
              >
                <X size={18} />
              </button>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {balanceDue !== undefined ? (
                <div className="rounded-md bg-[#f4f4f5] p-3">
                  <p className="text-xs font-semibold uppercase text-black/45">Saldo pendiente</p>
                  <p className="mt-1 font-semibold">{formatCurrency(balanceDue)}</p>
                </div>
              ) : null}
              {status ? (
                <div className="rounded-md bg-[#f4f4f5] p-3">
                  <p className="text-xs font-semibold uppercase text-black/45">Estado</p>
                  <p className="mt-1 font-semibold">{statusLabels[status] ?? status}</p>
                </div>
              ) : null}
            </div>

            <div className="mt-5 space-y-3">
              {activePayments.map((payment) => (
                <article key={payment.id} className="rounded-lg border border-black/10 bg-white p-4 shadow-sm">
                  <p className="font-semibold">{paymentDate(payment)}</p>
                  <p className="mt-1 text-sm text-black/70">
                    {formatCurrency(payment.amount)} · {paymentMethodLabels[payment.payment_method] ?? "Abono"}
                  </p>
                  {showRecordedBy ? <p className="mt-2 text-sm text-black/55">Registrado por: {recorderLabel(payment)}</p> : null}
                  {payment.reference ? <p className="mt-1 text-sm text-black/55">Referencia: {payment.reference}</p> : null}
                  {showNotes && payment.note ? <p className="mt-1 whitespace-pre-line text-sm text-black/55">Nota: {payment.note}</p> : null}
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
