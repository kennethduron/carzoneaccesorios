"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CreditCard, X } from "lucide-react";
import type { PurchaseConfirmationInput } from "@/app/admin/compras/actions";
import { Button, Input } from "@/components/ui";
import type { AdminPurchase, PurchasePaymentCondition } from "@/types/purchases";
import { formatCurrency } from "@/utils/pricing";

const paymentConditions: Array<{ value: PurchasePaymentCondition; label: string; help: string }> = [
  { value: "cash", label: "Contado", help: "La obligación se registra y queda pagada por el total." },
  { value: "credit", label: "Crédito", help: "Se registra el total como saldo pendiente." },
  { value: "partial", label: "Pago parcial", help: "Se aplica un pago inicial y queda el remanente pendiente." },
];

export function PurchaseConfirmationDialog({
  purchase,
  pending,
  onCancel,
  onConfirm,
}: {
  purchase: AdminPurchase;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (input: PurchaseConfirmationInput) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [requestKey] = useState(() => globalThis.crypto.randomUUID());
  const [condition, setCondition] = useState<PurchasePaymentCondition | "">("");
  const [dueDate, setDueDate] = useState("");
  const [initialAmount, setInitialAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PurchaseConfirmationInput["payment_method"]>(null);
  const [paymentDate, setPaymentDate] = useState(purchase.purchase_date);
  const [paymentNotes, setPaymentNotes] = useState("");
  const [error, setError] = useState("");

  const invoiceDueDate = purchase.supplier_invoice?.due_date ?? null;
  const requiresPayment = condition === "cash" || condition === "partial";
  const hasOutstandingBalance = condition === "credit" || condition === "partial";

  useEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      returnFocus.current?.focus();
    };
  }, []);

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape" && !pending) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex='-1'])") ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!condition) {
      setError("Selecciona una condición de pago.");
      return;
    }
    if (hasOutstandingBalance && !invoiceDueDate && !dueDate) {
      setError("Indica la fecha de vencimiento del saldo pendiente.");
      return;
    }
    if (condition === "partial") {
      const amount = Number(initialAmount);
      if (!Number.isFinite(amount) || amount <= 0 || amount >= purchase.total) {
        setError("El pago inicial debe ser mayor que cero y menor que el total.");
        return;
      }
    }
    if (requiresPayment && !paymentMethod) {
      setError("Selecciona el método del pago inicial.");
      return;
    }
    if (requiresPayment && !paymentDate) {
      setError("Indica la fecha del pago inicial.");
      return;
    }

    setError("");
    onConfirm({
      purchase_id: purchase.id,
      payment_condition: condition,
      due_date: dueDate || null,
      initial_payment_amount: condition === "partial" ? initialAmount : null,
      payment_method: requiresPayment ? paymentMethod : null,
      payment_date: requiresPayment ? paymentDate : null,
      payment_notes: requiresPayment ? paymentNotes : null,
      request_key: requestKey,
    });
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 p-3 sm:items-center" onMouseDown={(event) => event.target === event.currentTarget && !pending && onCancel()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={handleKeyDown} className="max-h-[calc(100%_-_1.5rem)] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-4 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#fff1f2] text-[#b91c25]"><CreditCard aria-hidden size={21} /></span>
            <div className="min-w-0">
              <h2 id={titleId} className="break-words text-xl font-semibold">Confirmar compra {purchase.purchase_number}</h2>
              <p id={descriptionId} className="mt-1 text-sm leading-6 text-black/60">La confirmación registrará una cuenta por pagar vinculada. El total se obtiene del servidor y no puede editarse aquí.</p>
            </div>
          </div>
          <button ref={closeRef} type="button" aria-label="Cerrar confirmación" disabled={pending} onClick={onCancel} className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c]"><X aria-hidden size={18} /></button>
        </div>

        <dl className="mt-5 grid gap-3 rounded-lg bg-[#f8fafc] p-4 text-sm sm:grid-cols-3">
          <div><dt className="text-black/50">Proveedor</dt><dd className="break-words font-semibold">{purchase.supplier_name}</dd></div>
          <div><dt className="text-black/50">Fecha</dt><dd className="font-semibold">{purchase.purchase_date}</dd></div>
          <div><dt className="text-black/50">Total canónico</dt><dd className="font-semibold">{formatCurrency(purchase.total)}</dd></div>
        </dl>

        <form className="mt-5 space-y-5" onSubmit={submit} aria-describedby={error ? errorId : undefined}>
          <fieldset disabled={pending}>
            <legend className="text-sm font-semibold">Condición de pago</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {paymentConditions.map((option) => (
                <label key={option.value} className={`flex min-h-24 cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${condition === option.value ? "border-[#e4252c] bg-[#fff1f2]" : "border-black/10 bg-white"}`}>
                  <input type="radio" name="payment-condition" value={option.value} checked={condition === option.value} onChange={() => { setCondition(option.value); setError(""); }} className="mt-1 size-4 accent-[#e4252c]" />
                  <span><span className="block font-semibold">{option.label}</span><span className="mt-1 block text-xs leading-5 text-black/55">{option.help}</span></span>
                </label>
              ))}
            </div>
          </fieldset>

          {condition ? (
            <div className="grid gap-4 rounded-lg border border-black/10 p-4">
              {hasOutstandingBalance ? invoiceDueDate ? (
                <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900"><span className="font-semibold">Vencimiento de factura proveedor:</span> {invoiceDueDate}. Esta fecha tendrá prioridad.</div>
              ) : (
                <label className="grid gap-1 text-sm font-semibold">Fecha de vencimiento<Input type="date" value={dueDate} onChange={(event) => { setDueDate(event.target.value); setError(""); }} disabled={pending} required /></label>
              ) : null}

              {condition === "partial" ? (
                <label className="grid gap-1 text-sm font-semibold">Pago inicial<Input type="number" min="0.01" max={Math.max(purchase.total - 0.01, 0.01)} step="0.01" value={initialAmount} onChange={(event) => { setInitialAmount(event.target.value); setError(""); }} disabled={pending} required /><span className="text-xs font-normal text-black/50">Debe ser menor que {formatCurrency(purchase.total)}.</span></label>
              ) : null}

              {condition === "cash" ? <div className="rounded-md bg-[#f4f4f5] p-3 text-sm"><span className="text-black/55">Pago de contado impuesto por el servidor:</span> <strong>{formatCurrency(purchase.total)}</strong></div> : null}

              {requiresPayment ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1 text-sm font-semibold">Método de pago<select value={paymentMethod ?? ""} onChange={(event) => { setPaymentMethod(event.target.value as PurchaseConfirmationInput["payment_method"]); setError(""); }} disabled={pending} required className="min-h-11 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"><option value="">Seleccionar</option><option value="cash">Efectivo</option><option value="bank_transfer">Transferencia bancaria</option><option value="card_credit">Tarjeta de crédito</option><option value="card_debit">Tarjeta de débito</option></select></label>
                    <label className="grid gap-1 text-sm font-semibold">Fecha del pago<Input type="date" value={paymentDate} onChange={(event) => { setPaymentDate(event.target.value); setError(""); }} disabled={pending} required /></label>
                  </div>
                  <label className="grid gap-1 text-sm font-semibold">Referencia o notas<textarea value={paymentNotes} onChange={(event) => setPaymentNotes(event.target.value)} disabled={pending} rows={2} maxLength={2000} className="min-h-20 rounded-md border border-black/10 px-3 py-2 text-sm" /></label>
                </>
              ) : null}
            </div>
          ) : null}

          {error ? <p id={errorId} role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-800">{error}</p> : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending} className="min-h-11">Revisar compra</Button>
            <Button type="submit" disabled={pending || !condition} className="min-h-11">{pending ? "Confirmando…" : "Confirmar y registrar CxP"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
