"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Ban, CheckCircle2, Copy, Download, ExternalLink, FilePenLine, FileText, PackageCheck, Printer, Search, XCircle } from "lucide-react";
import { cancelInvoiceAction, getInvoiceDetailAction } from "@/app/admin/facturas/actions";
import {
  correctOrderFiscalCustomerDataAction,
  addOrderInternalNoteAction,
  extendOrderReservationAction,
  generateInvoiceFromOrderAction,
  markCreditReceivablePaidAction,
  updateCashOnDeliveryFeeAction,
  updateOrderPaymentStatusAction,
  updateOrderStatusAction,
} from "@/app/admin/pedidos/actions";
import { AccountingTraceabilityCard } from "@/components/admin/accounting-traceability-card";
import { ActiveFilterBanner } from "@/components/admin/active-filter-banner";
import { OrderCommercialTerms } from "@/components/admin/order-commercial-terms";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { ContactActions } from "@/components/contact-actions";
import { OfficialInvoiceDocument } from "@/components/invoices/official-invoice-document";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { CommercialCreditPaymentReceivedMethod } from "@/types/credit";
import type { FiscalCorrectionHistoryEntry, FiscalCorrectionValueKey } from "@/types/fiscal-corrections";
import type { AdminInvoiceDetail } from "@/types/invoices";
import type { AdminOrderRow } from "@/types/orders";
import { adminInvoiceToOfficialInvoice } from "@/utils/invoice-document-mappers";
import { buildOfficialInvoicePrintHtml } from "@/utils/official-invoice-document";
import { formatHnDateTime } from "@/utils/format";
import { cashOnDeliveryApplies, isCashOnDeliveryPending } from "@/utils/cash-on-delivery";
import {
  canonicalOrderStatus,
  getAllowedOrderStatusOptions,
  isPaymentConfirmed,
  orderStatusLabels,
  paymentDisplayLabel,
  recommendedOrderAction,
} from "@/utils/order-workflow";
import { paymentMethodLabel } from "@/utils/payment-labels";
import { formatCurrency } from "@/utils/pricing";

type AdminOrdersManagerProps = {
  orders: AdminOrderRow[];
  total: number;
  page: number;
  pageSize: number;
  canConfirmPayments: boolean;
  canRejectPayments: boolean;
  canExtendReservations: boolean;
  canReviewReservations: boolean;
  canManageOrders: boolean;
  canCancelOrders: boolean;
  canManageLogistics: boolean;
  canGenerateInvoices: boolean;
  canAdjustSaleTerms: boolean;
  canMarkCreditPaid: boolean;
  canCancelInvoices: boolean;
  canCorrectInvoices: boolean;
  canViewFinancialData: boolean;
  orderPriceReviewEnabled: boolean;
  orderPriceConfirmationModalEnabled: boolean;
  activeTask?: { id: string; label: string } | null;
};

const paymentLabels: Record<string, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta mediante enlace de pago",
  cash: "Efectivo",
  commercial_credit: "Crédito comercial",
};

const creditPaymentReceivedLabels: Record<CommercialCreditPaymentReceivedMethod, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
};

const paymentTimingLabels: Record<string, string> = {
  before_delivery: "Antes del envío",
  on_delivery: "Al recibir",
};

const reservationStatusLabels: Record<string, string> = {
  not_required: "No aplica",
  reserved: "Reservado",
  confirmed: "Convertido en venta",
  released: "Liberado",
  expired: "Vencido",
  canceled: "Cancelado",
};

const nonCancelableOrderStatuses = new Set([
  "entregado",
  "delivered",
  "cancelado",
  "cancelled",
  "cerrado",
  "closed",
  "completado",
  "completed",
]);

const fiscalCorrectionFieldLabels: Record<FiscalCorrectionValueKey, string> = {
  customer_name: "Nombre fiscal",
  customer_rtn: "RTN",
  customer_phone: "Teléfono",
  customer_email: "Correo electrónico",
  customer_address: "Dirección fiscal",
};

const fiscalCorrectionWarning =
  "Esta acción actualizará únicamente el nombre fiscal y el RTN del pedido antes de emitir factura. La auditoría quedará registrada automáticamente.";
const fiscalCorrectionIssuedInvoiceWarning =
  "Este pedido ya tiene factura emitida. Para cambios fiscales, utiliza el proceso fiscal correspondiente.";

function adminInvoicePdfHref(invoiceId: string, download = false) {
  const href = `/api/admin/facturas/${encodeURIComponent(invoiceId)}/pdf`;
  return download ? `${href}?download=1` : href;
}

function buildOrderWhatsappMessage(order: AdminOrderRow) {
  const visibleItems = order.order_items.slice(0, 8);
  const productLines = visibleItems.map((item) => `* ${item.quantity} x ${item.product_name} — ${formatCurrency(item.line_total)}`);
  const remainingItems = order.order_items.length - visibleItems.length;

  if (remainingItems > 0) {
    productLines.push(`* ${remainingItems} productos adicionales. Ver detalle completo en el pedido.`);
  }

  const paymentMethod = paymentLabels[order.payment_method] ?? paymentMethodLabel(order.payment_method, { detailedCard: true });
  const commonIntro = [
    "Hola, gracias por contactar con Car Zone Accesorios.",
    "",
    "Te compartimos el resumen de tu pedido:",
    "",
    `Pedido: #${order.order_number}`,
    "",
    "Productos:",
    "",
    productLines.length > 0 ? productLines.join("\n") : "* Productos registrados en el pedido.",
    "",
    `Total a pagar: ${formatCurrency(order.total)}`,
    "",
    `Método de pago seleccionado: ${paymentMethod}.`,
  ];

  if (order.payment_method === "card") {
    return [
      "Hola, gracias por contactar con Car Zone Accesorios.",
      "",
      "Te compartimos el resumen de tu pedido:",
      "",
      `Pedido: #${order.order_number}`,
      "",
      "Productos:",
      "",
      productLines.length > 0 ? productLines.join("\n") : "* Productos registrados en el pedido.",
      "",
      `Total a pagar: ${formatCurrency(order.total)}`,
      "",
      "Método de pago seleccionado: tarjeta de crédito o débito mediante enlace de pago.",
      "",
      "Puedes realizar tu pago de forma segura por medio del siguiente enlace:",
      "",
      "Enlace de pago:",
      "",
      "Cuando completes el pago, por favor envíanos la confirmación o el comprobante por este chat para continuar con tu pedido.",
      "",
      "Gracias por comprar en Car Zone Accesorios.",
    ].join("\n");
  }

  if (order.payment_method === "bank_transfer") {
    return [
      ...commonIntro,
      "",
      order.payment_timing === "on_delivery"
        ? "Coordinaremos la entrega y la transferencia al recibir tu pedido."
        : "Por favor envíanos la confirmación, referencia o comprobante de transferencia por este chat para validar tu pago.",
      "",
      "Gracias por comprar en Car Zone Accesorios.",
    ].join("\n");
  }

  if (order.payment_method === "commercial_credit") {
    return [
      ...commonIntro,
      "",
      "Este pedido fue creado con crédito comercial autorizado. El pago se marcará como completo cuando el cliente cancele la cuenta por cobrar.",
      "",
      "Gracias por comprar en Car Zone Accesorios.",
    ].join("\n");
  }

  return [
    ...commonIntro,
    "",
    "Coordinaremos contigo la entrega y el pago en efectivo.",
    "",
    "Gracias por comprar en Car Zone Accesorios.",
  ].join("\n");
}

export function AdminOrdersManager({
  orders,
  total,
  page,
  pageSize,
  canConfirmPayments,
  canRejectPayments,
  canExtendReservations,
  canReviewReservations,
  canManageOrders,
  canCancelOrders,
  canManageLogistics,
  canGenerateInvoices,
  canAdjustSaleTerms,
  canMarkCreditPaid,
  canCancelInvoices,
  canCorrectInvoices,
  canViewFinancialData,
  orderPriceReviewEnabled,
  orderPriceConfirmationModalEnabled,
  activeTask = null,
}: AdminOrdersManagerProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState(orders[0]?.id ?? "");
  const [orderToCancel, setOrderToCancel] = useState<AdminOrderRow | null>(null);
  const [paymentToReject, setPaymentToReject] = useState<AdminOrderRow | null>(null);
  const [invoiceToCancel, setInvoiceToCancel] = useState<AdminOrderRow | null>(null);
  const [invoicePreview, setInvoicePreview] = useState<AdminInvoiceDetail | null>(null);
  const [orderToCorrectFiscalData, setOrderToCorrectFiscalData] = useState<AdminOrderRow | null>(null);
  const [orderToExtend, setOrderToExtend] = useState<AdminOrderRow | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const invoiceRequestKeys = useRef(new Map<string, string>());
  const toast = useToast();
  const debouncedQuery = useDebouncedValue(query, 400);

  function showAdminMessage(nextMessage: string, ok: boolean) {
    setMessage(nextMessage);
    if (ok) {
      toast.success(nextMessage);
    } else {
      toast.error(nextMessage);
    }
  }

  const filteredOrders = useMemo(() => {
    const normalizedQuery = debouncedQuery.trim().toLowerCase();
    return orders.filter((order) => {
      if (!normalizedQuery) return true;
      return `${order.order_number} ${order.tracking_code ?? ""} ${order.customer_name} ${order.email ?? ""} ${order.phone} ${
        order.bank_reference_number ?? ""
      } ${order.invoice_number ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [debouncedQuery, orders]);

  const selectedOrder = useMemo(
    () => filteredOrders.find((order) => order.id === selectedOrderId) ?? filteredOrders[0] ?? orders[0] ?? null,
    [filteredOrders, orders, selectedOrderId],
  );
  const pricingInconsistencies = useMemo(
    () => orderPriceReviewEnabled
      ? orders.filter((order) => order.price_review.status === "action_required")
      : orders.filter((order) =>
        order.order_items.some((item) => {
          const expectedSnapshot =
            item.applied_price_mode === 'wholesale'
              ? item.wholesale_price_snapshot
              : item.retail_price_snapshot;
          return (
            item.applied_price_mode !== order.price_mode ||
            Math.abs(item.unit_price - expectedSnapshot) > 0.005
          );
        }),
      ),
    [orderPriceReviewEnabled, orders],
  );

  function generateInvoice(order: AdminOrderRow) {
    if (orderHasActiveInvoice(order)) {
      if (!order.invoice_id) {
        showAdminMessage("Este pedido ya tiene una factura emitida, pero no se pudo ubicar el registro fiscal.", false);
        return;
      }

      startTransition(async () => {
        const detail = await getInvoiceDetailAction(order.invoice_id ?? "");
        showAdminMessage("Este pedido ya tiene una factura emitida. Se abrirá la factura existente.", Boolean(detail.ok && detail.invoice));
        if (detail.ok && detail.invoice) {
          setInvoicePreview(detail.invoice);
        }
      });
      return;
    }

    if (order.payment_method !== "commercial_credit" && !isPaymentConfirmed(order.payment_status)) {
      showAdminMessage("La factura solo puede generarse cuando el pago esté confirmado.", false);
      return;
    }

    if (isCashOnDeliveryPending(order.payment_method, order.payment_timing, order.cash_on_delivery_fee, order.delivery_mode)) {
      showAdminMessage("Debes confirmar el cargo contra entrega antes de emitir la factura.", false);
      return;
    }

    if (!canIssueInvoice(order)) {
      showAdminMessage("No se puede emitir factura: valida pago confirmado, pedido activo e inventario no liberado.", false);
      return;
    }

    startTransition(async () => {
      const requestKey = invoiceRequestKeys.current.get(order.id) ?? crypto.randomUUID();
      invoiceRequestKeys.current.set(order.id, requestKey);
      const result = await generateInvoiceFromOrderAction(order.id, requestKey);
      showAdminMessage(result.message, result.ok);
      if (result.ok && result.invoice) {
        invoiceRequestKeys.current.delete(order.id);
        setInvoicePreview(result.invoice);
        router.refresh();
      }
    });
  }

  function updatePaymentStatus(order: AdminOrderRow, status: "approved" | "rejected", reason = "") {
    const rejectionReason = reason.trim();
    if (status === "rejected" && rejectionReason.length < 4) {
      showAdminMessage("Ingresa un motivo para rechazar el pago.", false);
      return;
    }

    startTransition(async () => {
      const result = await updateOrderPaymentStatusAction(order.id, status, rejectionReason);
      showAdminMessage(result.message, result.ok);
      if (result.ok) router.refresh();
    });
  }

  function markCreditPaid(
    order: AdminOrderRow,
    payment: { paymentMethod: CommercialCreditPaymentReceivedMethod; paymentReference?: string },
  ) {
    if (!order.receivable_id) {
      showAdminMessage("Este pedido no tiene cuenta por cobrar vinculada.", false);
      return;
    }

    startTransition(async () => {
      const result = await markCreditReceivablePaidAction({
        receivableId: order.receivable_id ?? "",
        paymentMethod: payment.paymentMethod,
        paymentReference: payment.paymentReference,
      });
      showAdminMessage(result.message, result.ok);
      if (result.ok) router.refresh();
    });
  }

  function updateOrderStatus(order: AdminOrderRow, status: AdminOrderRow["status"], reason = "") {
    startTransition(async () => {
      const result = await updateOrderStatusAction(order.id, status, reason);
      showAdminMessage(result.message ?? "Estado del pedido actualizado.", result.ok);
      if (result.ok) router.refresh();
    });
  }

  function updateCashOnDeliveryFee(order: AdminOrderRow, fee: number) {
    startTransition(async () => {
      const result = await updateCashOnDeliveryFeeAction(order.id, fee);
      showAdminMessage(result.message, result.ok);
      if (result.ok) router.refresh();
    });
  }

  function extendReservation(order: AdminOrderRow, minutes: 720 | 1440 | 2880, reason: string) {
    startTransition(async () => {
      const result = await extendOrderReservationAction(order.id, minutes, reason);
      showAdminMessage(result.message, result.ok);
      if (result.ok) {
        setOrderToExtend(null);
        router.refresh();
      }
    });
  }

  function addInternalNote(order: AdminOrderRow, note: string) {
    startTransition(async () => {
      const result = await addOrderInternalNoteAction(order.id, note);
      showAdminMessage(result.message, result.ok);
      if (result.ok) router.refresh();
    });
  }

  function reprintInvoice(order: AdminOrderRow) {
    if (!order.invoice_id || !order.invoice_number) return;

    startTransition(async () => {
      const detail = await getInvoiceDetailAction(order.invoice_id ?? "");
      if (!detail.ok || !detail.invoice) {
        showAdminMessage(detail.message || "No se pudo cargar el detalle de la factura.", false);
        return;
      }

      setInvoicePreview(detail.invoice);
      showAdminMessage("Factura cargada para vista previa.", true);
    });
  }

  async function copyInvoiceWhatsappMessage(invoice: AdminInvoiceDetail) {
    const text = [
      "Hola, gracias por comprar en Car Zone Accesorios.",
      "",
      `Te compartimos tu factura correspondiente al pedido #${invoice.order_number}.`,
      "Adjuntamos el documento PDF en este chat para que puedas revisarlo y guardarlo.",
      "",
      "Gracias por tu compra.",
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      toast.success("Mensaje copiado. Ahora puedes pegarlo en WhatsApp y adjuntar el PDF.");
    } catch {
      toast.error("No se pudo copiar el mensaje. Intenta nuevamente.");
    }
  }

  function cancelInvoice(order: AdminOrderRow, reason: string) {
    if (!order.invoice_id) return;

    startTransition(async () => {
      const result = await cancelInvoiceAction(order.invoice_id ?? "", reason);
      showAdminMessage(result.message, result.ok);
      if (result.ok) {
        setInvoiceToCancel(null);
        router.refresh();
      }
    });
  }

  function correctFiscalCustomerData(input: {
    orderId: string;
    customerName: string;
    customerRtn: string;
  }) {
    startTransition(async () => {
      const result = await correctOrderFiscalCustomerDataAction(input);
      showAdminMessage(result.message, result.ok);
      if (result.ok) {
        setOrderToCorrectFiscalData(null);
        router.refresh();
      }
    });
  }

  if (orders.length === 0) {
    return (
      <div className="space-y-5">
        {activeTask ? <ActiveFilterBanner label={activeTask.label} clearHref="/admin/pedidos" /> : null}
        <PaginationControls
          basePath="/admin/pedidos"
          page={page}
          pageSize={pageSize}
          total={total}
          label="pedidos"
          params={activeTask ? { task: activeTask.id } : undefined}
        />
        <section className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">
          {activeTask ? "No hay resultados para este filtro operativo." : "No hay pedidos registrados."}
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {activeTask ? <ActiveFilterBanner label={activeTask.label} clearHref="/admin/pedidos" /> : null}
      {orderPriceReviewEnabled && pricingInconsistencies.length > 0 ? (
        <section className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" role="alert">
          <AlertTriangle className="mt-0.5 shrink-0" size={18} />
          <div>
            <p className="font-semibold">{"Revisi\u00f3n de precio requerida"}</p>
            <p className="mt-1">
              {"Existe evidencia incompleta o una diferencia econ\u00f3mica accionable en "}
              {pricingInconsistencies.map((order) => order.order_number).join(", ")}.
            </p>
          </div>
        </section>
      ) : null}
      {!orderPriceReviewEnabled && pricingInconsistencies.length > 0 ? (
        <section className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" role="alert">
          <AlertTriangle className="mt-0.5 shrink-0" size={18} />
          <div>
            <p className="font-semibold">Revisión de precio requerida</p>
            <p className="mt-1">
              La modalidad de precio de la cabecera no coincide con una o más líneas en{' '}
              {pricingInconsistencies.map((order) => order.order_number).join(', ')}.
            </p>
          </div>
        </section>
      ) : null}
      <PaginationControls
        basePath="/admin/pedidos"
        page={page}
        pageSize={pageSize}
        total={total}
        label="pedidos"
        params={activeTask ? { task: activeTask.id } : undefined}
      />
      <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm transition-all hover:shadow-md">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <label className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 transition-colors focus-within:border-[#e4252c] focus-within:ring-2 focus-within:ring-[#e4252c]/15">
            <Search size={18} className="text-black/45" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar por pedido, cliente, teléfono, referencia o factura"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          <button
            type="button"
            onClick={() => setQuery("")}
            className="rounded-md border border-black/10 bg-white px-4 py-2 text-sm font-semibold transition-all hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:bg-[#fff1f2]"
          >
            Limpiar filtros
          </button>
        </div>
      </section>

      <section className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <div className="min-w-0 overflow-hidden rounded-lg border border-black/10 bg-white">
          <div className="border-b border-black/10 p-4">
            <h2 className="font-semibold">Pedidos</h2>
            <p className="mt-1 text-sm text-black/55">{filteredOrders.length.toLocaleString("es-HN")} pedidos en esta página</p>
          </div>
          <div className="divide-y divide-black/10 lg:max-h-[calc(100vh-280px)] lg:overflow-y-auto lg:overscroll-contain">
            {filteredOrders.length === 0 ? <p className="p-4 text-sm text-black/55">No se encontraron resultados.</p> : null}
            {filteredOrders.map((order) => (
              <button
                key={order.id}
                type="button"
                onClick={() => setSelectedOrderId(order.id)}
                className={`block w-full p-4 text-left transition-colors ${
                  selectedOrder?.id === order.id ? "bg-[#fff1f2]" : "bg-white hover:bg-[#f4f4f5]"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="break-words font-semibold [overflow-wrap:anywhere]">{order.order_number}</p>
                  <span className="rounded-md bg-[#f4f4f5] px-2 py-1 text-xs font-semibold text-black/65">
                    {orderStatusLabels[canonicalOrderStatus(order.status)] ?? order.status}
                  </span>
                </div>
                {order.tracking_code ? <p className="mt-1 break-words text-xs text-[#b91c25] [overflow-wrap:anywhere]">{order.tracking_code}</p> : null}
                <p className="mt-1 break-words text-sm text-black/55 [overflow-wrap:anywhere]">{order.customer_name}</p>
                {canViewFinancialData ? <p className="mt-1 text-sm font-medium">{formatCurrency(order.total)}</p> : null}
                <p className="mt-1 text-xs text-black/50">{paymentDisplayLabel(order)}</p>
                {canViewFinancialData && order.invoice_number ? (
                  <p className="mt-1 break-words text-xs font-medium text-[#b91c25] [overflow-wrap:anywhere]">
                    Factura {order.invoice_number}
                    {order.invoice_status === "anulada" || order.invoice_status === "cancelled" ? " anulada" : ""}
                  </p>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        {selectedOrder ? (
          <OrderDetail
            key={selectedOrder.id}
            order={selectedOrder}
            canConfirmPayments={canConfirmPayments}
            canRejectPayments={canRejectPayments}
            canExtendReservations={canExtendReservations}
            canReviewReservations={canReviewReservations}
            canManageOrders={canManageOrders}
            canCancelOrders={canCancelOrders}
            canManageLogistics={canManageLogistics}
            canGenerateInvoices={canGenerateInvoices}
            canAdjustSaleTerms={canAdjustSaleTerms}
            canMarkCreditPaid={canMarkCreditPaid}
            canCancelInvoices={canCancelInvoices}
            canCorrectInvoices={canCorrectInvoices}
            canViewFinancialData={canViewFinancialData}
            orderPriceConfirmationModalEnabled={orderPriceConfirmationModalEnabled}
            isPending={isPending}
            message={message}
            onGenerateInvoice={() => generateInvoice(selectedOrder)}
            onApprovePayment={() => updatePaymentStatus(selectedOrder, "approved")}
            onMarkCreditPaid={(payment) => markCreditPaid(selectedOrder, payment)}
            onRejectPayment={() => setPaymentToReject(selectedOrder)}
            onCancelOrder={() => setOrderToCancel(selectedOrder)}
            onCancelInvoice={() => setInvoiceToCancel(selectedOrder)}
            onCorrectFiscalData={() => setOrderToCorrectFiscalData(selectedOrder)}
            onExtendReservation={() => setOrderToExtend(selectedOrder)}
            onAddInternalNote={(note) => addInternalNote(selectedOrder, note)}
            onUpdateOrderStatus={(status) => updateOrderStatus(selectedOrder, status)}
            onUpdateCashOnDeliveryFee={(fee) => updateCashOnDeliveryFee(selectedOrder, fee)}
            onReprintInvoice={() => reprintInvoice(selectedOrder)}
          />
        ) : null}
      </section>

      {orderToCancel ? (
        <CancelOrderModal
          order={orderToCancel}
          isPending={isPending}
          onClose={() => setOrderToCancel(null)}
          onCancel={async (reason) => {
            const confirmed = await toast.confirm({
              title: "Confirmar cancelación",
              message: "Esta acción será definitiva y quedará registrada en auditoría. ¿Confirmas que deseas cancelar este pedido?",
              confirmLabel: "Confirmar cancelación",
              cancelLabel: "Volver",
              tone: "danger",
            });

            if (!confirmed) {
              return;
            }

            updateOrderStatus(orderToCancel, "cancelado", reason);
            setOrderToCancel(null);
          }}
        />
      ) : null}
      {paymentToReject ? (
        <RejectPaymentModal
          order={paymentToReject}
          isPending={isPending}
          onClose={() => setPaymentToReject(null)}
          onReject={(reason) => {
            updatePaymentStatus(paymentToReject, "rejected", reason);
            setPaymentToReject(null);
          }}
        />
      ) : null}
      {invoiceToCancel ? (
        <CancelOrderInvoiceModal
          order={invoiceToCancel}
          isPending={isPending}
          onClose={() => setInvoiceToCancel(null)}
          onCancel={async (reason) => {
            const confirmed = await toast.confirm({
              title: "Confirmar anulación",
              message: "Esta acción será definitiva y quedará registrada en auditoría. ¿Confirmas que deseas anular esta factura?",
              confirmLabel: "Confirmar anulación",
              cancelLabel: "Volver",
              tone: "danger",
            });

            if (!confirmed) {
              return;
            }

            cancelInvoice(invoiceToCancel, reason);
          }}
        />
      ) : null}
      {orderToCorrectFiscalData ? (
        <CorrectOrderFiscalDataModal
          order={orderToCorrectFiscalData}
          isPending={isPending}
          onClose={() => setOrderToCorrectFiscalData(null)}
          onCorrect={correctFiscalCustomerData}
        />
      ) : null}
      {invoicePreview ? (
        <InvoicePreviewModal
          invoice={invoicePreview}
          onClose={() => setInvoicePreview(null)}
          onPrint={() => printInvoiceDocument(invoicePreview)}
          onCopyWhatsapp={() => void copyInvoiceWhatsappMessage(invoicePreview)}
        />
      ) : null}
      {orderToExtend ? (
        <ExtendReservationModal
          order={orderToExtend}
          isPending={isPending}
          onClose={() => setOrderToExtend(null)}
          onExtend={(minutes, reason) => extendReservation(orderToExtend, minutes, reason)}
        />
      ) : null}
    </div>
  );
}

function canIssueInvoice(order: AdminOrderRow) {
  const paymentConfirmed = isPaymentConfirmed(order.payment_status);
  const creditOrder = order.payment_method === "commercial_credit";
  const normalizedStatus = canonicalOrderStatus(order.status);
  const orderReady = ["confirmado", "preparacion", "empacado", "enviado", "en_ruta", "entregado"].includes(normalizedStatus);
  const reservationReleased = ["released", "expired", "canceled"].includes(order.order_reservation_status);
  return (
    (paymentConfirmed || creditOrder) &&
    orderReady &&
    normalizedStatus !== "cancelado" &&
    !reservationReleased &&
    !orderHasActiveInvoice(order) &&
    !isCashOnDeliveryPending(order.payment_method, order.payment_timing, order.cash_on_delivery_fee, order.delivery_mode)
  );
}

function OrderItemCard({
  item,
  canViewFinancialData,
}: {
  item: AdminOrderRow["order_items"][number];
  canViewFinancialData: boolean;
}) {
  return (
    <article className="rounded-md border border-black/10 bg-white p-3 text-sm">
      <p className="break-words font-semibold [overflow-wrap:anywhere]">{item.product_name}</p>
      <p className="mt-1 break-words text-xs text-black/50 [overflow-wrap:anywhere]">SKU: {item.sku || "-"}</p>
      <div className="mt-3 grid gap-2 text-xs text-black/60">
        <div className="flex items-center justify-between gap-3">
          <span>Cantidad</span>
          <span className="shrink-0 font-medium">{item.quantity}</span>
        </div>
        {canViewFinancialData ? (
          <div className="flex items-center justify-between gap-3">
            <span>Total</span>
            <span className="shrink-0 font-semibold">{formatCurrency(item.line_total)}</span>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function orderHasActiveInvoice(order: AdminOrderRow) {
  return Boolean(order.invoice_number && !["anulada", "cancelled"].includes(String(order.invoice_status ?? "")));
}

function AuthorizedPriceAdjustmentNotice({ order }: { order: AdminOrderRow }) {
  if (order.price_review.status !== "authorized_manual_override") return null;
  return (
    <section className="rounded-lg border border-[#0f766e]/25 bg-[#f0fdfa] p-3 text-sm text-[#134e4a]" aria-label="Precio personalizado autorizado">
      <div className="flex items-start gap-2">
        <CheckCircle2 className="mt-0.5 shrink-0" size={18} />
        <div className="min-w-0">
          <p className="font-semibold">{"Precio personalizado autorizado"}</p>
          <p className="mt-1 text-xs leading-5 text-[#115e59]">
            {"El precio final tiene evidencia de un ajuste realizado por un usuario autorizado. No requiere correcci\u00f3n operativa."}
          </p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {order.price_review.adjustments.map((adjustment) => {
          const item = order.order_items.find((candidate) => candidate.id === adjustment.orderItemId);
          return (
            <div key={`${adjustment.auditId}-${adjustment.orderItemId}`} className="rounded-md border border-[#0f766e]/15 bg-white p-3 text-xs">
              <p className="font-semibold text-black">{item?.product_name ?? item?.sku ?? "Producto"}</p>
              <p className="mt-1">Autorizado por: {adjustment.actorName ?? adjustment.actorRole}</p>
              <p>Fecha: {formatHnDateTime(adjustment.adjustedAt)}</p>
              <p>Precio anterior: {formatCurrency(adjustment.previousUnitPrice)}</p>
              <p>Precio final: {formatCurrency(adjustment.finalUnitPrice)}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function OrderDetail({
  order,
  canConfirmPayments,
  canRejectPayments,
  canExtendReservations,
  canReviewReservations,
  canManageOrders,
  canCancelOrders,
  canManageLogistics,
  canGenerateInvoices,
  canAdjustSaleTerms,
  canMarkCreditPaid,
  canCancelInvoices,
  canCorrectInvoices,
  canViewFinancialData,
  orderPriceConfirmationModalEnabled,
  isPending,
  message,
  onGenerateInvoice,
  onApprovePayment,
  onMarkCreditPaid,
  onRejectPayment,
  onCancelOrder,
  onCancelInvoice,
  onCorrectFiscalData,
  onExtendReservation,
  onAddInternalNote,
  onUpdateOrderStatus,
  onUpdateCashOnDeliveryFee,
  onReprintInvoice,
}: {
  order: AdminOrderRow;
  canConfirmPayments: boolean;
  canRejectPayments: boolean;
  canExtendReservations: boolean;
  canReviewReservations: boolean;
  canManageOrders: boolean;
  canCancelOrders: boolean;
  canManageLogistics: boolean;
  canGenerateInvoices: boolean;
  canAdjustSaleTerms: boolean;
  canMarkCreditPaid: boolean;
  canCancelInvoices: boolean;
  canCorrectInvoices: boolean;
  canViewFinancialData: boolean;
  orderPriceConfirmationModalEnabled: boolean;
  isPending: boolean;
  message: string;
  onGenerateInvoice: () => void;
  onApprovePayment: () => void;
  onMarkCreditPaid: (payment: { paymentMethod: CommercialCreditPaymentReceivedMethod; paymentReference?: string }) => void;
  onRejectPayment: () => void;
  onCancelOrder: () => void;
  onCancelInvoice: () => void;
  onCorrectFiscalData: () => void;
  onExtendReservation: () => void;
  onAddInternalNote: (note: string) => void;
  onUpdateOrderStatus: (status: AdminOrderRow["status"]) => void;
  onUpdateCashOnDeliveryFee: (fee: number) => void;
  onReprintInvoice: () => void;
}) {
  const normalizedStatus = canonicalOrderStatus(order.status);
  const isBankTransfer = order.payment_method === "bank_transfer";
  const isCash = order.payment_method === "cash";
  const isCard = order.payment_method === "card";
  const isCredit = order.payment_method === "commercial_credit";
  const [commercialTermsDirty, setCommercialTermsDirty] = useState(false);
  const [creditPaymentMethod, setCreditPaymentMethod] = useState<CommercialCreditPaymentReceivedMethod | "">(order.receivable_payment_received_method ?? "");
  const [creditPaymentReference, setCreditPaymentReference] = useState(order.receivable_payment_received_reference ?? "");
  const allowedStatuses = getAllowedOrderStatusOptions(order);
  const manualStatuses = allowedStatuses.filter((option) => option.value !== "cancelado");
  const paymentIsApproved = isPaymentConfirmed(order.payment_status);
  const paymentIsRejected = order.payment_status === "rejected";
  const invoiceCanBeIssued = canIssueInvoice(order);
  const invoiceIsCancelled = order.invoice_status === "anulada" || order.invoice_status === "cancelled";
  const hasActiveInvoice = Boolean(order.invoice_number && !invoiceIsCancelled);
  const cashOnDeliveryRequired = cashOnDeliveryApplies(order.payment_method, order.payment_timing, order.delivery_mode);
  const cashOnDeliveryPending = isCashOnDeliveryPending(order.payment_method, order.payment_timing, order.cash_on_delivery_fee, order.delivery_mode);
  const canEditCashOnDelivery =
    (canManageOrders || canConfirmPayments) && cashOnDeliveryRequired && !hasActiveInvoice && normalizedStatus !== "cancelado";
  const cashOnDeliveryLockedReason = hasActiveInvoice
    ? "El cargo contra entrega no puede modificarse porque la factura fiscal ya fue emitida."
    : normalizedStatus === "cancelado"
      ? "No se puede modificar el cargo contra entrega de un pedido cancelado."
      : null;
  const [cashOnDeliveryFeeDraft, setCashOnDeliveryFeeDraft] = useState({
    orderId: order.id,
    value: String(order.cash_on_delivery_fee ?? 0),
  });
  const currentOrderStatus = String(order.status ?? "").toLowerCase();
  const cancellationBlocked =
    nonCancelableOrderStatuses.has(currentOrderStatus) || nonCancelableOrderStatuses.has(normalizedStatus);
  const canCancelOrder = !cancellationBlocked && allowedStatuses.some((option) => option.value === "cancelado");
  const canAcceptOrder = normalizedStatus === "recibido" && allowedStatuses.some((option) => option.value === "confirmado");
  const canConfirmPayment =
    canConfirmPayments &&
    !isCredit &&
    !paymentIsApproved &&
    !paymentIsRejected &&
    normalizedStatus !== "cancelado" &&
    (order.payment_timing !== "on_delivery" || normalizedStatus === "entregado");
  const paymentActionLabel = isCard ? "Confirmar pago mediante enlace" : "Confirmar pago recibido";
  const creditPaymentIsPaid = isCredit && order.receivable_status === "paid";
  const canSubmitCreditPayment = Boolean(creditPaymentMethod) && !creditPaymentIsPaid;
  const visibleManualStatuses = canManageOrders
    ? manualStatuses
    : manualStatuses.filter((option) => ["preparacion", "empacado", "enviado", "en_ruta", "entregado"].includes(option.value));
  const currentStatusOption = { value: normalizedStatus, label: orderStatusLabels[normalizedStatus] ?? String(normalizedStatus) };
  const safeManualStatuses = visibleManualStatuses.some((option) => option.value === normalizedStatus)
    ? visibleManualStatuses
    : [currentStatusOption, ...visibleManualStatuses];
  const nextStatusActionOptions = [
    { status: "preparacion", label: "Marcar en preparación" },
    { status: "empacado", label: "Marcar empacado" },
    { status: "enviado", label: "Marcar enviado" },
    { status: "en_ruta", label: "Marcar en ruta" },
    { status: "entregado", label: "Marcar entregado" },
  ] satisfies Array<{ status: AdminOrderRow["status"]; label: string }>;
  const nextStatusActions = nextStatusActionOptions.filter((action) => allowedStatuses.some((option) => option.value === action.status));
  const cashOnDeliveryFeeInput =
    cashOnDeliveryFeeDraft.orderId === order.id ? cashOnDeliveryFeeDraft.value : String(order.cash_on_delivery_fee ?? 0);

  return (
    <article className="min-w-0 overflow-hidden rounded-lg border border-black/10 bg-white">
      <div className="flex flex-col justify-between gap-3 border-b border-black/10 p-4 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <p className="text-sm text-black/50">{formatHnDateTime(order.created_at)}</p>
          <h2 className="mt-1 flex min-w-0 items-center gap-2 break-words text-xl font-semibold [overflow-wrap:anywhere]">
            <PackageCheck size={22} className="shrink-0" />
            {order.order_number}
          </h2>
          <p className="mt-1 break-words text-sm text-black/60 [overflow-wrap:anywhere]">
            {order.customer_name} / {order.phone}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:justify-end">
          <Badge tone={normalizedStatus === "cancelado" ? "danger" : "default"}>{orderStatusLabels[normalizedStatus] ?? order.status}</Badge>
          <Badge tone={paymentIsApproved ? "success" : paymentIsRejected ? "danger" : "warning"}>{paymentDisplayLabel(order)}</Badge>
          {canViewFinancialData ? <Badge tone="neutral">{formatCurrency(order.total)}</Badge> : null}
        </div>
      </div>

      <div className="grid gap-3 border-b border-black/10 p-4 md:grid-cols-2 xl:grid-cols-4">
        <CompactInfo label="Estado del pedido" value={orderStatusLabels[normalizedStatus] ?? order.status} />
        <CompactInfo label="Estado del pago" value={paymentDisplayLabel(order)} />
        <CompactInfo label="Reserva" value={order.reservation_review_required ? "Vencida: requiere revisión" : reservationStatusLabels[order.order_reservation_status] ?? order.order_reservation_status} />
        <CompactInfo label="Número de seguimiento" value={order.tracking_code ?? "Sin código"} />
      </div>

      <div className="space-y-4 p-4">
        {normalizedStatus === "cancelado" ? (
          <div className="rounded-md border border-[#9b341b]/25 bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
            Este pedido está cancelado. No requiere avance operativo.
          </div>
        ) : null}

        {order.reservation_review_required ? (
          <ReservationReviewPanel
            order={order}
            canExtendReservations={canExtendReservations}
            canReviewReservations={canReviewReservations}
            isPending={isPending}
            onExtendReservation={onExtendReservation}
            onAddInternalNote={onAddInternalNote}
          />
        ) : null}

        <div className="rounded-md border border-[#f59e0b]/30 bg-[#fffbeb] p-3">
          <p className="text-sm font-semibold text-[#7c2d12]">Acción recomendada</p>
          <p className="mt-1 text-sm text-[#7c2d12]">{recommendedOrderAction(order)}</p>
        </div>

        {canViewFinancialData ? (
          <>
            <AuthorizedPriceAdjustmentNotice order={order} />
            <OrderCommercialTerms
              order={order}
              canEdit={canAdjustSaleTerms}
              confirmationModalEnabled={orderPriceConfirmationModalEnabled}
              onDirtyChange={setCommercialTermsDirty}
            />
          </>
        ) : null}

        {isCredit && order.receivable_id ? (
          <div className="rounded-md border border-black/10 bg-[#f4f4f5] p-3 text-sm">
            <p className="font-semibold">Pago recibido del crédito</p>
            {creditPaymentIsPaid ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <CompactInfo
                  label="Método recibido"
                  value={order.receivable_payment_received_method ? creditPaymentReceivedLabels[order.receivable_payment_received_method] : "No registrado"}
                />
                <CompactInfo label="Referencia" value={order.receivable_payment_received_reference ?? "Sin referencia"} />
                <CompactInfo label="Fecha de pago" value={order.receivable_paid_at ? formatHnDateTime(order.receivable_paid_at) : "No disponible"} />
              </div>
            ) : canMarkCreditPaid ? (
              <div className="mt-3 grid gap-3 md:grid-cols-[240px_1fr]">
                <label>
                  <span className="mb-1 block text-xs font-medium uppercase text-black/50">Método con el que pagó el cliente</span>
                  <select
                    value={creditPaymentMethod}
                    onChange={(event) => {
                      const nextMethod = event.target.value as CommercialCreditPaymentReceivedMethod | "";
                      setCreditPaymentMethod(nextMethod);
                      if (nextMethod === "cash") setCreditPaymentReference("");
                    }}
                    className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Seleccionar</option>
                    <option value="bank_transfer">Transferencia bancaria</option>
                    <option value="card">Tarjeta</option>
                    <option value="cash">Efectivo</option>
                  </select>
                </label>
                {creditPaymentMethod === "bank_transfer" || creditPaymentMethod === "card" ? (
                  <label>
                    <span className="mb-1 block text-xs font-medium uppercase text-black/50">
                      {creditPaymentMethod === "bank_transfer" ? "Número de referencia" : "Referencia / enlace / comprobante"}
                    </span>
                    <Input value={creditPaymentReference} onChange={(event) => setCreditPaymentReference(event.target.value)} />
                  </label>
                ) : null}
              </div>
            ) : (
              <p className="mt-2 text-black/55">Solo lectura. No tienes permiso para registrar el pago del crédito.</p>
            )}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          <ContactActions phone={order.phone} customerName={order.customer_name} whatsappMessage={buildOrderWhatsappMessage(order)} />
          {order.tracking_code ? (
            <button
              type="button"
              onClick={async () => navigator.clipboard.writeText(order.tracking_code ?? "")}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-medium sm:w-auto"
            >
              <Copy size={15} />
              Copiar número de seguimiento
            </button>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          {canManageOrders && canAcceptOrder ? (
            <Button onClick={() => onUpdateOrderStatus("confirmado")} disabled={isPending} variant="primary" className="w-full sm:w-auto">
              <CheckCircle2 size={17} />
              Aceptar pedido
            </Button>
          ) : null}
          {canManageLogistics ? nextStatusActions.map((action) => (
            <Button key={action.status} onClick={() => onUpdateOrderStatus(action.status)} disabled={isPending} variant="ghost" className="w-full sm:w-auto">
              <CheckCircle2 size={17} />
              {action.label}
            </Button>
          )) : null}
          {canConfirmPayment ? (
            <Button onClick={onApprovePayment} disabled={isPending} variant="primary" className="w-full sm:w-auto">
              <CheckCircle2 size={17} />
              {isPending ? "Procesando..." : paymentActionLabel}
            </Button>
          ) : null}
          {canMarkCreditPaid && isCredit && order.receivable_id && order.receivable_status !== "paid" && order.receivable_status !== "cancelled" ? (
            <Button
              onClick={() =>
                creditPaymentMethod
                  ? onMarkCreditPaid({ paymentMethod: creditPaymentMethod, paymentReference: creditPaymentReference })
                  : undefined
              }
              disabled={isPending || !canSubmitCreditPayment}
              variant="primary"
              className="w-full sm:w-auto"
            >
              <CheckCircle2 size={17} />
              {isPending ? "Procesando..." : "Marcar crédito como pagado"}
            </Button>
          ) : null}
          {canRejectPayments && (isBankTransfer || isCard) && !paymentIsApproved && !paymentIsRejected && normalizedStatus !== "cancelado" ? (
            <Button onClick={onRejectPayment} disabled={isPending} variant="secondary" className="w-full sm:w-auto">
              <XCircle size={17} />
              Rechazar pago
            </Button>
          ) : null}
          {canGenerateInvoices && !order.invoice_number ? (
            <Button onClick={onGenerateInvoice} disabled={isPending || !invoiceCanBeIssued || commercialTermsDirty} variant="dark" className="min-h-11 w-full sm:w-auto">
              <FileText size={17} />
              {isPending ? "Generando..." : "Generar factura"}
            </Button>
          ) : null}
          {canViewFinancialData && order.invoice_number ? (
            <Button onClick={onReprintInvoice} variant="ghost" className="w-full sm:w-auto">
              <FileText size={17} />
              {invoiceIsCancelled ? "Ver factura anulada" : "Ver factura"}
            </Button>
          ) : null}
          {canCancelInvoices && hasActiveInvoice ? (
            <Button onClick={onCancelInvoice} disabled={isPending} variant="secondary" className="w-full sm:w-auto">
              <Ban size={17} />
              Anular factura
            </Button>
          ) : null}
          {canCorrectInvoices && canViewFinancialData ? (
            <Button onClick={onCorrectFiscalData} disabled={isPending || invoiceIsCancelled} variant="ghost" className="w-full sm:w-auto">
              <FilePenLine size={17} />
              Editar datos fiscales
            </Button>
          ) : null}
          {canCancelOrders && canCancelOrder ? (
            <Button onClick={onCancelOrder} disabled={isPending} variant="secondary" className="w-full sm:w-auto">
              <XCircle size={17} />
              Cancelar pedido
            </Button>
          ) : null}
        </div>

        <div className="grid gap-3 lg:grid-cols-[220px_1fr]">
          <label className="rounded-md border border-black/10 bg-[#f4f4f5] p-3">
            <span className="text-xs font-medium uppercase text-black/50">Avance manual seguro</span>
            <select
              value={normalizedStatus}
              onChange={(event) => onUpdateOrderStatus(event.target.value as AdminOrderRow["status"])}
              disabled={isPending || !canManageLogistics || safeManualStatuses.length <= 1}
              className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
            >
              {safeManualStatuses.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
            <CompactInfo label="Cliente" value={order.customer_name} />
            <CompactInfo label="Teléfono" value={order.phone} />
            {order.tracking_code ? <CompactInfo label="Código" value={order.tracking_code} /> : null}
            {canViewFinancialData ? <CompactInfo label="RTN" value={order.fiscal_customer_rtn ?? "Sin RTN"} /> : null}
          </div>
        </div>

        {canViewFinancialData ? (
          <details className="rounded-md border border-black/10 bg-white p-3" open={isBankTransfer || Boolean(order.invoice_number)}>
            <summary className="cursor-pointer text-sm font-semibold">Detalles operativos y fiscales</summary>
            <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
              <CompactInfo label="Precio usado" value={order.price_mode === "wholesale" ? "Mayorista" : "Detalle"} />
              <CompactInfo label="Método de pago" value={paymentLabels[order.payment_method] ?? paymentMethodLabel(order.payment_method, { detailedCard: true })} />
              <CompactInfo label="Momento del pago" value={paymentTimingLabels[order.payment_timing] ?? order.payment_timing} />
              <CompactInfo label="Subtotal antes de ISV" value={formatCurrency(order.subtotal)} />
              <CompactInfo label="ISV incluido 15%" value={formatCurrency(order.tax)} />
              <CompactInfo label="Total" value={formatCurrency(order.total)} />
              <CompactInfo label="Envío" value={order.shipping_fee === 0 ? "Gratis" : formatCurrency(order.shipping_fee)} />
              <CompactInfo
                label="Contra entrega"
                value={cashOnDeliveryRequired && cashOnDeliveryPending ? "Pendiente de confirmación" : formatCurrency(order.cash_on_delivery_fee)}
              />
              <CompactInfo label="Recargo mínimo" value={formatCurrency(order.small_order_fee)} />
              <CompactInfo label="Descuentos" value={order.discount_total > 0 ? `-${formatCurrency(order.discount_total)}` : formatCurrency(0)} />
              <CompactInfo label="Otros cargos" value={formatCurrency(order.additional_fees.reduce((sum, fee) => sum + fee.amount, 0))} />
              <CompactInfo label="Nombre fiscal" value={order.fiscal_customer_name} />
              <CompactInfo label="RTN fiscal" value={order.fiscal_customer_rtn ?? "Sin RTN"} />
              <CompactInfo label="Dirección fiscal" value={order.fiscal_customer_address ?? "Sin dirección"} />
              <CompactInfo label="Factura fiscal" value={order.invoice_number ?? "Sin factura"} />
              <CompactInfo label="Estado factura" value={invoiceIsCancelled ? "Factura anulada" : order.invoice_number ? "Factura emitida" : "Sin factura"} />
              {isCredit ? (
                <CompactInfo
                  label="Estado crédito"
                  value={
                    order.receivable_status === "paid"
                      ? "Pagado"
                      : order.receivable_status === "partial"
                        ? "Pago parcial"
                        : order.receivable_status === "overdue"
                          ? "Vencido"
                          : order.receivable_status === "cancelled"
                            ? "Cancelado"
                            : "Abierto"
                  }
                />
              ) : null}
              {isCredit ? <CompactInfo label="Saldo por cobrar" value={formatCurrency(order.receivable_balance_due ?? 0)} /> : null}
              {isCredit ? <CompactInfo label="Vence" value={order.receivable_due_date ?? "Sin fecha"} /> : null}
            </div>
            {isBankTransfer ? (
              <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <CompactInfo label="Referencia bancaria" value={order.bank_reference_number ?? "Sin referencia"} />
                <div className="rounded-md bg-[#f4f4f5] px-3 py-2">
                  <p className="text-xs uppercase text-black/45">Comprobante</p>
                  {order.transfer_receipt_url ? (
                    <a
                      href={order.transfer_receipt_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-medium"
                    >
                      <ExternalLink size={16} />
                      Ver comprobante
                    </a>
                  ) : (
                    <p className="mt-2 text-sm text-black/65">Sin comprobante adjunto.</p>
                  )}
                </div>
              </div>
            ) : null}
            {invoiceIsCancelled ? (
              <p className="mt-3 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
                Factura anulada. Motivo: {order.invoice_cancellation_reason ?? "motivo registrado en auditoría"}.
              </p>
            ) : null}
          </details>
        ) : null}

        {canViewFinancialData ? (
          <AccountingTraceabilityCard traceability={order.accounting_traceability} />
        ) : null}

        {canViewFinancialData && cashOnDeliveryRequired ? (
          <section className="rounded-md border border-[#f59e0b]/30 bg-[#fffbeb] p-4 text-sm text-[#7c2d12]">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <h3 className="font-semibold">Contra entrega</h3>
                <p className="mt-1">
                  Estado: {cashOnDeliveryPending ? "pendiente de confirmación" : `cargo definido en ${formatCurrency(order.cash_on_delivery_fee)}`}.
                </p>
                <p className="mt-1">Total actual del pedido: {formatCurrency(order.total)}</p>
                {cashOnDeliveryLockedReason ? <p className="mt-2 font-medium">{cashOnDeliveryLockedReason}</p> : null}
                {cashOnDeliveryPending ? (
                  <p className="mt-2 font-medium">Debes confirmar el cargo contra entrega antes de emitir la factura.</p>
                ) : null}
              </div>
              <Badge tone={cashOnDeliveryPending ? "warning" : "success"}>
                {cashOnDeliveryPending ? "Pendiente" : "Definido"}
              </Badge>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,220px)_auto]">
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-[#7c2d12]/75">Cargo contra entrega</span>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={cashOnDeliveryFeeInput}
                  onChange={(event) => setCashOnDeliveryFeeDraft({ orderId: order.id, value: event.target.value })}
                  disabled={isPending || !canEditCashOnDelivery}
                />
              </label>
              <Button
                onClick={() => onUpdateCashOnDeliveryFee(Number(cashOnDeliveryFeeInput))}
                disabled={isPending || !canEditCashOnDelivery || !Number.isFinite(Number(cashOnDeliveryFeeInput)) || Number(cashOnDeliveryFeeInput) < 0}
                variant="primary"
                className="w-full self-end sm:w-auto"
              >
                {isPending ? "Guardando..." : "Guardar cargo contra entrega"}
              </Button>
            </div>
          </section>
        ) : null}

        {canCorrectInvoices && canViewFinancialData ? <FiscalCorrectionHistory history={order.fiscal_correction_history} /> : null}

        {isCard && !paymentIsApproved ? (
          <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">
            Pago con tarjeta mediante enlace pendiente de envío o confirmación. Usa WhatsApp para enviar el enlace y confirma manualmente cuando el pago se haya verificado.
          </p>
        ) : null}
        {isCash && !paymentIsApproved && normalizedStatus !== "entregado" && normalizedStatus !== "cancelado" ? (
          <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">
            El pago en efectivo se confirma después de marcar el pedido como entregado.
          </p>
        ) : null}
        {canGenerateInvoices && !order.invoice_number && !invoiceCanBeIssued ? (
          <p className="rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
            {cashOnDeliveryPending
              ? "Debes confirmar el cargo contra entrega antes de emitir la factura."
              : isCredit
                ? "La factura de crédito solo puede emitirse si el pedido está activo y la reserva de inventario no fue liberada."
              : "La factura solo puede generarse cuando el pago esté confirmado. También debe ser un pedido activo con inventario no liberado."}
          </p>
        ) : null}
        {message ? <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">{message}</p> : null}

        <div className="overflow-hidden rounded-lg border border-black/10">
          <div className="bg-[#e7e5e4] px-4 py-3 text-sm font-semibold">Productos</div>
          <div className="grid gap-3 p-3 md:hidden">
            {order.order_items.map((item) => (
              <OrderItemCard key={`${order.id}-${item.id}-card`} item={item} canViewFinancialData={canViewFinancialData} />
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[620px] text-left text-sm">
              <thead className="text-xs uppercase text-black/50">
                <tr>
                  <th className="px-3 py-2">Producto</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Cant.</th>
                  {canViewFinancialData ? <th className="px-3 py-2 text-right">Total</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {order.order_items.map((item) => (
                  <tr key={`${order.id}-${item.id}`}>
                    <td className="px-3 py-2 break-words [overflow-wrap:anywhere]">{item.product_name}</td>
                    <td className="px-3 py-2 break-words text-black/55 [overflow-wrap:anywhere]">{item.sku}</td>
                    <td className="px-3 py-2">{item.quantity}</td>
                    {canViewFinancialData ? <td className="px-3 py-2 text-right font-medium">{formatCurrency(item.line_total)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {canViewFinancialData ? (
          <p className="rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
            Validar tratamiento fiscal de envío y comisión con la contadora.
          </p>
        ) : null}
      </div>
    </article>
  );
}

function CancelOrderModal({
  order,
  isPending,
  onCancel,
  onClose,
}: {
  order: AdminOrderRow;
  isPending: boolean;
  onCancel: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const canSubmit = reason.trim().length >= 8;

  return (
    <ConfirmReasonModal
      title="Cancelar pedido"
      identifier={order.order_number}
      reasonLabel="Motivo de cancelación"
      description="El pedido quedará como estado final y la reserva se liberará si aplica."
      notice="Esta acción será definitiva y quedará registrada en auditoría."
      icon={<XCircle size={18} />}
      reason={reason}
      isPending={isPending}
      canSubmit={canSubmit}
      submitLabel="Cancelar pedido"
      onReasonChange={setReason}
      onSubmit={() => onCancel(reason)}
      onClose={onClose}
    />
  );
}

function ReservationReviewPanel({
  order,
  canExtendReservations,
  canReviewReservations,
  isPending,
  onExtendReservation,
  onAddInternalNote,
}: {
  order: AdminOrderRow;
  canExtendReservations: boolean;
  canReviewReservations: boolean;
  isPending: boolean;
  onExtendReservation: () => void;
  onAddInternalNote: (note: string) => void;
}) {
  const [note, setNote] = useState("");

  return (
    <section className="rounded-md border border-[#f59e0b]/35 bg-[#fffbeb] p-4 text-sm text-[#7c2d12]">
      <p className="font-semibold">Reserva vencida: requiere revisión</p>
      <p className="mt-1">
        El stock sigue reservado. Revisa el pago y el avance del pedido antes de confirmar, extender o cancelar.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        {canExtendReservations ? (
          <Button onClick={onExtendReservation} disabled={isPending} variant="ghost" className="w-full sm:w-auto">
            Extender reserva
          </Button>
        ) : null}
      </div>
      {canReviewReservations ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
          <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Agregar nota interna" />
          <Button
            onClick={() => {
              onAddInternalNote(note);
              setNote("");
            }}
            disabled={isPending || note.trim().length < 3}
            variant="ghost"
            className="w-full sm:w-auto"
          >
            Guardar nota
          </Button>
        </div>
      ) : null}
      {order.order_internal_notes.length > 0 ? (
        <div className="mt-3 space-y-1">
          {order.order_internal_notes.slice(0, 3).map((item) => (
            <p key={item.id} className="rounded-md bg-white/70 px-3 py-2 text-xs">
              {item.note}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ExtendReservationModal({
  order,
  isPending,
  onExtend,
  onClose,
}: {
  order: AdminOrderRow;
  isPending: boolean;
  onExtend: (minutes: 720 | 1440 | 2880, reason: string) => void;
  onClose: () => void;
}) {
  const [minutes, setMinutes] = useState<720 | 1440 | 2880>(1440);
  const [reason, setReason] = useState("");

  return (
    <div className="cz-layer-modal fixed inset-0 overflow-y-auto bg-black/45 p-3 sm:p-4">
      <section className="mx-auto my-4 max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-4 text-[#080808] sm:my-10 sm:p-5">
        <h2 className="text-xl font-semibold">Extender reserva</h2>
        <p className="mt-1 text-sm text-black/60">{order.order_number}</p>
        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium uppercase text-black/50">Tiempo adicional</span>
          <select
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value) as 720 | 1440 | 2880)}
            className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
          >
            <option value={720}>12 horas</option>
            <option value={1440}>24 horas</option>
            <option value={2880}>48 horas</option>
          </select>
        </label>
        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium uppercase text-black/50">Motivo</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-24 w-full rounded-md border border-black/10 px-3 py-2 text-sm"
          />
        </label>
        <div className="mt-5 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-end">
          <Button onClick={onClose} variant="ghost" className="w-full sm:w-auto">
            Cancelar
          </Button>
          <Button onClick={() => onExtend(minutes, reason)} disabled={isPending || reason.trim().length < 4} variant="primary" className="w-full sm:w-auto">
            Extender reserva
          </Button>
        </div>
      </section>
    </div>
  );
}

function InvoicePreviewModal({
  invoice,
  onPrint,
  onCopyWhatsapp,
  onClose,
}: {
  invoice: AdminInvoiceDetail;
  onPrint: () => void;
  onCopyWhatsapp: () => void;
  onClose: () => void;
}) {
  const officialInvoice = adminInvoiceToOfficialInvoice(invoice);

  return (
    <div className="cz-layer-modal fixed inset-0 overflow-hidden bg-black/45 p-0 print:static print:bg-white print:p-0 sm:p-4">
      <section className="mx-auto flex h-[100dvh] w-full max-w-full flex-col overflow-hidden rounded-none bg-white text-[#080808] shadow-xl print:my-0 print:max-w-none print:rounded-none print:shadow-none sm:my-6 sm:h-auto sm:max-h-[calc(100dvh-3rem)] sm:max-w-6xl sm:rounded-lg">
        <div className="flex shrink-0 flex-col gap-3 border-b border-black/10 p-4 print:hidden sm:flex-row sm:items-start sm:justify-between sm:p-5">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold text-[#b91c25]">
              <FileText size={18} />
              Factura emitida
            </p>
            <h2 className="mt-1 break-words text-xl font-semibold [overflow-wrap:anywhere] sm:text-2xl">{invoice.invoice_number}</h2>
            <p className="mt-1 text-sm text-black/55">Pedido #{invoice.order_number}</p>
          </div>
          <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-2 lg:flex lg:flex-wrap">
            <a
              href={adminInvoicePdfHref(invoice.id)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-center text-sm font-semibold leading-snug text-[#080808] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#e4252c]/30 hover:bg-[#fff1f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2"
            >
              <ExternalLink size={16} />
              Abrir factura
            </a>
            <a
              href={adminInvoicePdfHref(invoice.id, true)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center justify-center gap-2 rounded-md bg-[#e4252c] px-3 py-2 text-center text-sm font-semibold leading-snug text-white shadow-sm shadow-[#e4252c]/20 transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#b91c25] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2"
            >
              <Download size={16} />
              Descargar PDF
            </a>
            <Button onClick={onPrint} variant="ghost" className="w-full whitespace-normal px-3 sm:w-auto">
              <Printer size={16} />
              Imprimir
            </Button>
            <Button onClick={onCopyWhatsapp} variant="ghost" className="w-full whitespace-normal px-3 sm:w-auto">
              <Copy size={16} />
              Copiar mensaje WhatsApp
            </Button>
            <Button onClick={onClose} variant="secondary" className="w-full whitespace-normal px-3 sm:w-auto">
              Volver al pedido
            </Button>
          </div>
        </div>
        <p className="mx-4 mb-3 rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60 sm:mx-5">
          En celular, abre la factura y usa Compartir o Guardar PDF si la descarga no inicia automáticamente.
        </p>

        <div className="min-h-0 flex-1 overflow-y-auto bg-[#d4d4d4]">
          <OfficialInvoiceDocument invoice={officialInvoice} />
        </div>
      </section>
    </div>
  );
}

function printInvoiceDocument(invoice: AdminInvoiceDetail) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.srcdoc = buildOfficialInvoicePrintHtml(adminInvoiceToOfficialInvoice(invoice), { baseUrl: window.location.origin });
  document.body.appendChild(iframe);

  iframe.onload = () => {
    const printWindow = iframe.contentWindow;
    if (!printWindow) {
      iframe.remove();
      return;
    }

    printWindow.focus();
    printWindow.print();
    window.setTimeout(() => iframe.remove(), 1000);
  };
}

function CorrectOrderFiscalDataModal({
  order,
  isPending,
  onCorrect,
  onClose,
}: {
  order: AdminOrderRow;
  isPending: boolean;
  onCorrect: (input: {
    orderId: string;
    customerName: string;
    customerRtn: string;
  }) => void;
  onClose: () => void;
}) {
  const [customerName, setCustomerName] = useState(order.fiscal_customer_name);
  const [customerRtn, setCustomerRtn] = useState(order.fiscal_customer_rtn ?? "");
  const normalizedRtn = customerRtn.trim().replace(/[\s-]/g, "");
  const rtnIsValid = normalizedRtn.length === 0 || /^\d{14}$/.test(normalizedRtn);
  const hasIssuedInvoice = Boolean(order.invoice_number);
  const canSubmit = customerName.trim().length >= 2 && rtnIsValid && !hasIssuedInvoice;

  function submitCorrection() {
    onCorrect({
      orderId: order.id,
      customerName,
      customerRtn,
    });
  }

  return (
    <div className="cz-layer-modal fixed inset-0 overflow-y-auto bg-black/45 p-3 sm:p-4">
      <section className="mx-auto my-4 max-h-[calc(100dvh-2rem)] w-full max-w-3xl overflow-y-auto rounded-lg bg-white p-4 text-[#080808] sm:my-8 sm:p-5">
        <div className="flex items-start justify-between gap-3 border-b border-black/10 pb-4">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-[#b91c25]">
              <FilePenLine size={18} />
              Corregir datos fiscales
            </p>
            <h2 className="mt-1 text-2xl font-semibold">{order.order_number}</h2>
            <p className="mt-1 text-sm text-black/55">
              {order.invoice_number ? `Factura ${order.invoice_number}` : "Pedido sin factura emitida"}
            </p>
          </div>
          <Button onClick={onClose} variant="ghost" className="w-full sm:w-auto">
            Cerrar
          </Button>
        </div>

        {hasIssuedInvoice ? (
          <p className="mt-5 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
            {fiscalCorrectionIssuedInvoiceWarning}
          </p>
        ) : (
          <>
            <p className="mt-4 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
              {fiscalCorrectionWarning}
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Nombre / Razón social</span>
                <Input value={customerName} onChange={(event) => setCustomerName(event.target.value)} />
                {customerName.trim().length > 0 && customerName.trim().length < 2 ? (
                  <p className="mt-1 text-xs font-medium text-[#b91c25]">Ingresa un nombre fiscal válido.</p>
                ) : null}
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">RTN del cliente</span>
                <Input value={customerRtn} onChange={(event) => setCustomerRtn(event.target.value)} placeholder="14 dígitos o vacío" />
                {!rtnIsValid ? <p className="mt-1 text-xs font-medium text-[#b91c25]">El RTN debe contener 14 dígitos.</p> : null}
              </label>
            </div>
            <div className="mt-5 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-end">
              <Button onClick={onClose} variant="ghost" className="w-full sm:w-auto">
                Cancelar
              </Button>
              <Button
                onClick={submitCorrection}
                disabled={isPending || !canSubmit}
                variant="primary"
                className="w-full sm:w-auto"
              >
                {isPending ? "Guardando..." : "Guardar corrección"}
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function FiscalCorrectionHistory({ history }: { history: FiscalCorrectionHistoryEntry[] }) {
  return (
    <section className="rounded-md border border-black/10 bg-white p-3">
      <h3 className="text-sm font-semibold">Historial de correcciones fiscales</h3>
      {history.length === 0 ? (
        <p className="mt-2 text-sm text-black/55">Sin correcciones fiscales registradas.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-3 py-2">Fecha</th>
                <th className="px-3 py-2">Usuario</th>
                <th className="px-3 py-2">Campo</th>
                <th className="px-3 py-2">Valor anterior</th>
                <th className="px-3 py-2">Valor nuevo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {history.flatMap((entry) => {
                const fields =
                  entry.fields_modified.length > 0
                    ? entry.fields_modified
                    : (Object.keys(entry.new_values) as FiscalCorrectionValueKey[]);
                return fields.map((field) => (
                  <tr key={`${entry.id}-${field}`}>
                    <td className="px-3 py-2">{formatHnDateTime(entry.created_at)}</td>
                    <td className="px-3 py-2">
                      {entry.user_label ?? "Usuario"}
                      {entry.actor_role ? <span className="block text-xs text-black/45">{entry.actor_role}</span> : null}
                    </td>
                    <td className="px-3 py-2">{fiscalCorrectionFieldLabels[field] ?? field}</td>
                    <td className="px-3 py-2">{entry.old_values[field] || "-"}</td>
                    <td className="px-3 py-2">{entry.new_values[field] || "-"}</td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RejectPaymentModal({
  order,
  isPending,
  onReject,
  onClose,
}: {
  order: AdminOrderRow;
  isPending: boolean;
  onReject: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const canSubmit = reason.trim().length >= 4 && confirmation.trim() === order.order_number;

  return (
    <ConfirmReasonModal
      title="Rechazar pago"
      identifier={order.order_number}
      reasonLabel="Motivo del rechazo"
      description="El pago rechazado cancelará el pedido y liberará la reserva según la lógica de inventario."
      icon={<XCircle size={18} />}
      reason={reason}
      confirmation={confirmation}
      isPending={isPending}
      canSubmit={canSubmit}
      submitLabel="Rechazar pago"
      onReasonChange={setReason}
      onConfirmationChange={setConfirmation}
      onSubmit={() => onReject(reason)}
      onClose={onClose}
    />
  );
}

function CancelOrderInvoiceModal({
  order,
  isPending,
  onCancel,
  onClose,
}: {
  order: AdminOrderRow;
  isPending: boolean;
  onCancel: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const invoiceNumber = order.invoice_number ?? "";
  const canSubmit = reason.trim().length >= 8;

  return (
    <ConfirmReasonModal
      title="Anular factura"
      identifier={invoiceNumber}
      reasonLabel="Motivo de anulación"
      description="No se elimina la factura: conserva número fiscal, CAI, fecha, motivo y auditoría."
      notice="Esta acción será definitiva y quedará registrada en auditoría."
      icon={<Ban size={18} />}
      reason={reason}
      isPending={isPending}
      canSubmit={canSubmit}
      submitLabel="Anular factura"
      onReasonChange={setReason}
      onSubmit={() => onCancel(reason)}
      onClose={onClose}
    />
  );
}

function ConfirmReasonModal({
  title,
  identifier,
  reasonLabel,
  description,
  notice,
  icon,
  reason,
  confirmation,
  isPending,
  canSubmit,
  submitLabel,
  onReasonChange,
  onConfirmationChange,
  onSubmit,
  onClose,
}: {
  title: string;
  identifier: string;
  reasonLabel: string;
  description: string;
  notice?: string;
  icon: React.ReactNode;
  reason: string;
  confirmation?: string;
  isPending: boolean;
  canSubmit: boolean;
  submitLabel: string;
  onReasonChange: (value: string) => void;
  onConfirmationChange?: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div className="cz-layer-modal fixed inset-0 overflow-y-auto bg-black/45 p-3 sm:p-4">
      <section className="mx-auto my-4 max-h-[calc(100dvh-2rem)] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-4 text-[#080808] sm:my-10 sm:p-5">
        <div className="border-b border-black/10 pb-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-[#9b341b]">
            {icon}
            {title}
          </p>
          <h2 className="mt-1 text-2xl font-semibold">{identifier}</h2>
          <p className="mt-2 text-sm text-black/60">{description}</p>
        </div>
        {notice ? <p className="mt-4 rounded-md bg-[#fff7ed] p-3 text-sm font-medium text-[#7c2d12]">{notice}</p> : null}
        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium uppercase text-black/50">{reasonLabel}</span>
          <textarea
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            className="min-h-28 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
          />
        </label>
        {onConfirmationChange ? (
          <label className="mt-4 block">
            <span className="mb-1 block text-xs font-medium uppercase text-black/50">Confirmación del pedido</span>
            <input
              value={confirmation ?? ""}
              onChange={(event) => onConfirmationChange(event.target.value)}
              placeholder={`Escribe ${identifier}`}
              className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
            />
          </label>
        ) : null}
        <div className="mt-5 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:justify-end">
          <Button onClick={onClose} variant="ghost" className="w-full sm:w-auto">
            Cerrar
          </Button>
          <Button onClick={onSubmit} disabled={isPending || !canSubmit} variant="secondary" className="w-full sm:w-auto">
            {submitLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}

function CompactInfo({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-[#f4f4f5] px-3 py-2">
      <p className="text-xs uppercase text-black/45">{label}</p>
      <p className="mt-1 break-words font-medium [overflow-wrap:anywhere]" title={value}>
        {value}
      </p>
    </div>
  );
}

function Badge({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "success" | "warning" | "danger" | "neutral";
}) {
  const classes = {
    default: "bg-[#fff1f2] text-[#b91c25]",
    success: "bg-[#ecfdf5] text-[#047857]",
    warning: "bg-[#fffbeb] text-[#92400e]",
    danger: "bg-[#fff7ed] text-[#9b341b]",
    neutral: "bg-[#f4f4f5] text-black/70",
  };

  return <span className={`w-fit max-w-full rounded-md px-3 py-2 text-sm font-medium whitespace-normal [overflow-wrap:anywhere] ${classes[tone]}`}>{children}</span>;
}
