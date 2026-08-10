"use client";

import { useMemo, useRef, useState } from "react";
import { CheckCircle2, CreditCard, LoaderCircle, PlusCircle, Printer, ReceiptText } from "lucide-react";
import type {
  PosConfirmationPaymentInput,
  PosCreditOverdueOverrideCapability,
  PosInventoryConflict,
  PosConfirmationResult,
  PosCustomerContext,
  PosPaymentMethod,
  PosSaleDraft,
} from "@/types/point-of-sale";
import { paymentMethodLabel } from "@/utils/payment-labels";
import { formatCurrency } from "@/utils/pricing";
import { PosCreditOverdueOverrideDialog } from "@/components/admin/pos-credit-overdue-override-dialog";

type Props = {
  draft: PosSaleDraft;
  customer: PosCustomerContext;
  disabled: boolean;
  onConfirmed: (result: PosConfirmationResult) => void;
  onInventoryConflict: () => Promise<PosInventoryConflict[]>;
  onViewReservations: (item: PosInventoryConflict) => void;
  onNewSale: () => void;
  operatorName: string;
  initialResult?: PosConfirmationResult | null;
  creditOverrideCapability?: PosCreditOverdueOverrideCapability;
};

type ConfirmationError = { code: string; message: string };

function hondurasDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function escapeReceiptText(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

export function printPosReceipt(
  result: PosConfirmationResult,
  draft: PosSaleDraft,
  customerName: string,
  operatorName: string,
) {
  const popup = window.open("", "_blank", "width=420,height=720");
  if (!popup) return;
  const change = result.changeDue === null ? "" : `<p><strong>Cambio:</strong> ${formatCurrency(result.changeDue)}</p>`;
  const amountTendered = result.amountTendered === null
    ? ""
    : `<p><strong>Monto recibido:</strong> ${formatCurrency(result.amountTendered)}</p>`;
  const items = draft.items.map((item) => `<div class="item"><div>${escapeReceiptText(item.productName)}</div><div class="row"><span>${item.quantity} x ${formatCurrency(item.finalUnitPrice)}</span><strong>${formatCurrency(item.lineMerchandiseGross)}</strong></div></div>`).join("");
  const charges = [
    { label: "Entrega", amount: draft.shippingFee },
    { label: "Contra entrega", amount: draft.codFee },
    { label: draft.additionalChargeDescription || "Cargo adicional", amount: draft.additionalCharge },
    { label: draft.otherChargeDescription || "Otro cargo", amount: draft.otherCharge },
  ].filter((charge) => charge.amount > 0).map((charge) => `<div class="row"><span>${escapeReceiptText(charge.label)}</span><span>${formatCurrency(charge.amount)}</span></div>`).join("");
  const orderNumber = escapeReceiptText(result.orderNumber);
  const invoiceNumber = escapeReceiptText(result.invoiceNumber);
  const safeCustomerName = escapeReceiptText(customerName);
  const safeOperatorName = escapeReceiptText(operatorName);
  const paymentMethod = escapeReceiptText(paymentMethodLabel(result.paymentMethod));
  popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Recibo ${orderNumber}</title><style>
    @page{size:80mm auto;margin:5mm}body{font-family:ui-monospace,monospace;max-width:70mm;margin:auto;color:#111}h1,h2,p{text-align:center}hr{border:0;border-top:1px dashed #555}.row{display:flex;justify-content:space-between;gap:8px}.item{margin:8px 0}button{width:100%;padding:12px;margin-top:16px}@media print{button{display:none}}
  </style></head><body><h1>Car Zone Accesorios</h1><p>Recibo POS</p><hr><p><strong>Pedido:</strong> ${orderNumber}</p><p><strong>Factura:</strong> ${invoiceNumber}</p><p><strong>Fecha:</strong> ${escapeReceiptText(result.invoiceDate)}</p><p><strong>Cliente:</strong> ${safeCustomerName}</p><p><strong>Usuario responsable:</strong> ${safeOperatorName}</p><hr>${items}<hr><div class="row"><span>Gravado</span><span>${formatCurrency(draft.taxableGross)}</span></div><div class="row"><span>Exento</span><span>${formatCurrency(draft.exemptGross)}</span></div><div class="row"><span>ISV incluido</span><span>${formatCurrency(draft.taxAmount)}</span></div>${charges}<div class="row"><strong>Total</strong><strong>${formatCurrency(result.total)}</strong></div><p><strong>Método:</strong> ${paymentMethod}</p>${amountTendered}${change}<p>${escapeReceiptText(result.receiptReference)}</p><hr><p>Gracias por su compra.</p><button onclick="window.print()">Imprimir</button></body></html>`);
  popup.document.close();
}

export function PosConfirmationPanel({ draft, customer, disabled, onConfirmed, onInventoryConflict, onViewReservations, onNewSale, operatorName, initialResult = null, creditOverrideCapability = { featureEnabled: false, overrideAllowed: false } }: Props) {
  const [method, setMethod] = useState<PosPaymentMethod>("cash");
  const [invoiceDate, setInvoiceDate] = useState(hondurasDate);
  const [amountTendered, setAmountTendered] = useState(String(draft.grandTotal));
  const [reference, setReference] = useState("");
  const [verified, setVerified] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmationError, setConfirmationError] = useState<ConfirmationError | null>(null);
  const [inventoryConflicts, setInventoryConflicts] = useState<PosInventoryConflict[]>([]);
  const [result, setResult] = useState<PosConfirmationResult | null>(initialResult);
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const requestKey = useRef<string | null>(null);

  const cashChange = useMemo(() => {
    const received = Number(amountTendered);
    return Number.isFinite(received) ? Math.round((received - draft.grandTotal) * 100) / 100 : 0;
  }, [amountTendered, draft.grandTotal]);
  const creditAllowed = customer.credit.canUseCredit
    && customer.credit.availableCredit >= draft.grandTotal;
  const insufficientAvailableCredit = customer.credit.enabled
    && ["active", "on_hold"].includes(customer.credit.status)
    && customer.credit.availableCredit < draft.grandTotal;
  const creditMessage = insufficientAvailableCredit
    ? "El crédito disponible es insuficiente para el total de esta venta."
    : creditAllowed
      ? "El crédito disponible se verificará nuevamente al confirmar."
      : customer.credit.reason;
  const overdueOverrideApplicable = creditOverrideCapability.featureEnabled
    && creditOverrideCapability.overrideAllowed
    && customer.credit.status === "on_hold"
    && customer.credit.enabled
    && customer.credit.overdueBalance > 0
    && customer.credit.availableCredit >= draft.grandTotal;
  const paymentReady = method === "cash"
    ? Number(amountTendered) >= draft.grandTotal
    : method === "bank_transfer" ? verified && reference.trim().length > 0
      : method === "card" ? verified
        : creditAllowed;

  async function confirm(overdueOverrideReason?: string) {
    const usingOverdueOverride = Boolean(overdueOverrideReason?.trim());
    if (pending || disabled || !accepted || (!paymentReady && !usingOverdueOverride)) return;
    if (usingOverdueOverride && !overdueOverrideApplicable) return;
    setPending(true);
    setConfirmationError(null);
    setInventoryConflicts([]);
    requestKey.current ??= crypto.randomUUID();
    const payment: PosConfirmationPaymentInput = method === "cash"
      ? { method, amountTendered: Number(amountTendered) }
      : method === "bank_transfer"
        ? { method, verified: true, reference: reference.trim() }
        : method === "card"
          ? { method, verified: true, reference: reference.trim() || null }
          : { method, ...(usingOverdueOverride ? { overdueOverrideReason: overdueOverrideReason!.trim() } : {}) };
    try {
      const response = await fetch(`/api/admin/pos/drafts/${draft.draftId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          requestKey: requestKey.current,
          expectedDraftVersion: draft.version,
          invoiceDate,
          payment,
        }),
      });
      const payload = await response.json() as PosConfirmationResult & { code?: string; message?: string };
      if (!response.ok) {
        const error: ConfirmationError = {
          code: payload.code || "POS_CONFIRMATION_FAILED",
          message: payload.message || "No se pudo confirmar la venta.",
        };
        setConfirmationError(error);
        if (error.code === "POS_INSUFFICIENT_STOCK" || error.code === "POS_PRODUCT_INACTIVE") {
          const conflicts = await onInventoryConflict();
          setInventoryConflicts(conflicts);
        }
        return;
      }
      setResult(payload);
      onConfirmed(payload);
    } catch (error) {
      setConfirmationError({
        code: "POS_CONFIRMATION_FAILED",
        message: error instanceof Error ? error.message : "No se pudo confirmar la venta.",
      });
    } finally {
      setPending(false);
    }
  }

  if (result) {
    return <section className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 shadow-sm">
      <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 text-emerald-700" /><div>
        <h2 className="font-semibold text-emerald-950">Venta confirmada</h2>
        <p className="text-sm text-emerald-900">Pedido {result.orderNumber} · Factura {result.invoiceNumber}</p>
      </div></div>
      <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-2 text-sm">
        <dt>Pedido</dt><dd className="text-right font-semibold">{result.orderNumber}</dd>
        <dt>Factura</dt><dd className="text-right font-semibold">{result.invoiceNumber}</dd>
        <dt>Cliente</dt><dd className="text-right font-semibold">{customer.displayName}</dd>
        <dt>Fecha de factura</dt><dd className="text-right font-semibold">{result.invoiceDate}</dd>
        <dt>Total</dt><dd className="text-right font-semibold">{formatCurrency(result.total)}</dd>
        <dt>Método</dt><dd className="text-right font-semibold">{paymentMethodLabel(result.paymentMethod)}</dd>
        {result.paymentId ? <><dt>Pago registrado</dt><dd className="text-right font-semibold">{formatCurrency(result.total)}</dd></> : null}
        {result.receivableId ? <><dt>Saldo CxC</dt><dd className="text-right font-semibold">{formatCurrency(result.total)}</dd></> : null}
        {result.amountTendered !== null ? <><dt>Recibido</dt><dd className="text-right font-semibold">{formatCurrency(result.amountTendered)}</dd></> : null}
        {result.changeDue !== null ? <><dt>Cambio</dt><dd className="text-right font-semibold">{formatCurrency(result.changeDue)}</dd></> : null}
        <dt>Origen</dt><dd className="text-right font-semibold">Punto de venta</dd>
        <dt>Responsable</dt><dd className="text-right font-semibold">{operatorName}</dd>
      </dl>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <a className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#e4252c] px-4 text-sm font-semibold text-white" href={`/api/admin/facturas/${result.invoiceId}/pdf?download=1`}><ReceiptText size={18} /> Descargar factura PDF</a>
        <a target="_blank" rel="noreferrer" href={`/api/admin/facturas/${result.invoiceId}/pdf`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-black/15 bg-white px-4 text-sm font-semibold"><Printer size={18} /> Imprimir factura</a>
        <a href={`/admin/pedidos?orderId=${encodeURIComponent(result.orderId)}`} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-black/15 bg-white px-4 text-sm font-semibold">Ver pedido</a>
        <a href={`/admin/facturas?invoiceId=${encodeURIComponent(result.invoiceId)}`} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-black/15 bg-white px-4 text-sm font-semibold">Ver factura</a>
        {result.receivableId ? <a href={`/admin/cuentas-por-cobrar?receivableId=${encodeURIComponent(result.receivableId)}`} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-black/15 bg-white px-4 text-sm font-semibold">Ver cuenta por cobrar</a> : null}
        {result.paymentId ? <a href={`/admin/pedidos?orderId=${encodeURIComponent(result.orderId)}&paymentId=${encodeURIComponent(result.paymentId)}`} className="inline-flex min-h-11 items-center justify-center rounded-lg border border-black/15 bg-white px-4 text-sm font-semibold">Ver pago</a> : null}
        <button type="button" onClick={onNewSale} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-black/15 bg-white px-4 text-sm font-semibold"><PlusCircle size={18} /> Nueva venta</button>
      </div>
    </section>;
  }

  return <section id="pos-confirmation" data-testid="pos-confirmation-panel" className="rounded-xl border border-black/10 bg-white p-3 shadow-sm">
    <div className="flex items-center gap-2"><CreditCard size={19} className="text-[#e4252c]" /><h2 className="font-semibold">Confirmar venta</h2></div>
    <p className="mt-1 text-xs text-black/55 min-[1320px]:sr-only">Revise la información antes de confirmar. Al continuar se generarán el pedido y la factura.</p>
    <div className="min-[1320px]:grid min-[1320px]:grid-cols-2 min-[1320px]:gap-x-2">
    <label className="mt-3 block min-w-0 text-sm font-medium">Fecha de factura<input type="date" value={invoiceDate} max={hondurasDate()} onChange={(event) => { setInvoiceDate(event.target.value); requestKey.current = null; }} className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-black/15 px-3" /></label>
    <label className="mt-3 block min-w-0 text-sm font-medium">Método de pago<select value={method} onChange={(event) => { setMethod(event.target.value as PosPaymentMethod); setVerified(false); setReference(""); requestKey.current = null; }} className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-black/15 px-3"><option value="cash">Efectivo</option><option value="bank_transfer">Transferencia bancaria</option><option value="card">Tarjeta</option><option value="commercial_credit">Crédito comercial</option></select></label>
    {method === "cash" ? <><label className="mt-3 block min-w-0 text-sm font-medium">Efectivo recibido<input inputMode="decimal" value={amountTendered} onChange={(event) => { setAmountTendered(event.target.value); requestKey.current = null; }} className="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-black/15 px-3" /></label><div className="mt-3 flex min-h-11 min-w-0 items-center justify-between self-end rounded-lg bg-black/[0.04] p-3 text-sm"><span>Cambio estimado</span><strong className={cashChange < 0 ? "text-red-700" : ""}>{formatCurrency(Math.max(0, cashChange))}</strong></div></> : null}
    {method === "bank_transfer" || method === "card" ? <div className="mt-3 space-y-3 min-[1320px]:col-span-2"><label className="block text-sm font-medium">Referencia {method === "card" ? "(opcional)" : ""}<input value={reference} maxLength={200} onChange={(event) => { setReference(event.target.value); requestKey.current = null; }} className="mt-1 min-h-11 w-full rounded-lg border border-black/15 px-3" /></label><label className="flex min-h-11 items-center gap-2 rounded-lg border border-black/10 px-3 text-sm"><input type="checkbox" checked={verified} onChange={(event) => { setVerified(event.target.checked); requestKey.current = null; }} /> Pago verificado por el operador</label></div> : null}
    {method === "commercial_credit" ? <div className={`mt-3 rounded-lg p-3 text-sm min-[1320px]:col-span-2 ${creditAllowed ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-900"}`}><p>Disponible: <strong>{formatCurrency(customer.credit.availableCredit)}</strong></p>{customer.credit.overdueBalance > 0 ? <p>Saldo vencido: <strong>{formatCurrency(customer.credit.overdueBalance)}</strong></p> : null}<p>{creditMessage}</p>{overdueOverrideApplicable ? <button type="button" disabled={disabled || pending || !accepted} onClick={() => { setConfirmationError(null); setOverrideDialogOpen(true); }} className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg border border-red-300 bg-white px-4 font-semibold text-red-800 disabled:opacity-50">Autorizar excepcionalmente</button> : null}</div> : null}
    </div>
    <label className="mt-3 flex min-h-11 items-center gap-3 rounded-lg px-1 py-2 text-sm"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} className="size-5 shrink-0" /><span>Confirmo que los productos, precios y datos son correctos.</span></label>
    {confirmationError && ["POS_INSUFFICIENT_STOCK", "POS_PRODUCT_INACTIVE"].includes(confirmationError.code) && inventoryConflicts.length > 0 ? <div role="alert" data-error-code={confirmationError.code} className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      <p className="font-semibold">No hay suficientes unidades disponibles para completar esta venta.</p>
      {inventoryConflicts.length === 1 ? inventoryConflicts.map((conflict) => <div key={conflict.productId} className="mt-2">
        <p className="font-semibold">{conflict.productName}</p>
        <p className="mt-1">Existencia física: {conflict.physicalStock} · Reservadas por pedidos activos: {conflict.reservedStock} · Disponibles: {conflict.availableStock} · Solicitadas: {conflict.requestedQuantity}</p>
        {conflict.hasActiveReservations ? <button type="button" onClick={() => onViewReservations(conflict)} className="mt-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-4">Ver pedidos relacionados</button> : null}
      </div>) : inventoryConflicts.length > 1 ? <ul className="mt-2 space-y-1">{inventoryConflicts.map((conflict) => <li key={conflict.productId}><strong>{conflict.productName}</strong> — disponibles {conflict.availableStock} / solicitadas {conflict.requestedQuantity}{conflict.hasActiveReservations ? <button type="button" onClick={() => onViewReservations(conflict)} className="ml-2 min-h-11 font-semibold underline underline-offset-4">Ver pedidos</button> : null}</li>)}</ul> : <p className="mt-2">Las existencias se actualizaron. Revise las cantidades del carrito.</p>}
      <p className="mt-2">Ajuste la cantidad para continuar.</p>
    </div> : confirmationError ? <p role="alert" data-error-code={confirmationError.code} className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">{confirmationError.message}</p> : null}
    <button type="button" disabled={disabled || pending || !accepted || !paymentReady || !invoiceDate} onClick={() => void confirm()} className="mt-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#e4252c] px-4 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{pending ? <LoaderCircle className="animate-spin motion-reduce:animate-none" size={19} /> : <CheckCircle2 size={19} />} Confirmar venta por {formatCurrency(draft.grandTotal)}</button>
    {overrideDialogOpen ? <PosCreditOverdueOverrideDialog customerName={customer.displayName} saleTotal={draft.grandTotal} creditLimit={customer.credit.creditLimit} openBalance={customer.credit.openBalance} availableCredit={customer.credit.availableCredit} overdueBalance={customer.credit.overdueBalance} reason={overrideReason} pending={pending} error={confirmationError?.message} onReasonChange={(value) => { setOverrideReason(value); setConfirmationError(null); requestKey.current = null; }} onCancel={() => { if (!pending) setOverrideDialogOpen(false); }} onConfirm={() => void confirm(overrideReason)} /> : null}
  </section>;
}
