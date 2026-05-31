"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, CheckCircle2, Copy, ExternalLink, FilePenLine, FileText, PackageCheck, Printer, Search, XCircle } from "lucide-react";
import { cancelInvoiceAction, getInvoiceDetailAction, logInvoiceReprintAction } from "@/app/admin/facturas/actions";
import {
  correctOrderFiscalCustomerDataAction,
  generateInvoiceFromOrderAction,
  updateOrderPaymentStatusAction,
  updateOrderStatusAction,
} from "@/app/admin/pedidos/actions";
import { ActiveFilterBanner } from "@/components/admin/active-filter-banner";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { ContactActions } from "@/components/contact-actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { FiscalCorrectionHistoryEntry, FiscalCorrectionValueKey } from "@/types/fiscal-corrections";
import type { AdminOrderRow } from "@/types/orders";
import { exportAdminInvoicePdf } from "@/utils/admin-invoice-pdf";
import { formatHnDateTime } from "@/utils/format";
import {
  canonicalOrderStatus,
  getAllowedOrderStatusOptions,
  isPaymentConfirmed,
  orderStatusLabels,
  paymentDisplayLabel,
  recommendedOrderAction,
} from "@/utils/order-workflow";
import { formatCurrency } from "@/utils/pricing";

type AdminOrdersManagerProps = {
  orders: AdminOrderRow[];
  total: number;
  page: number;
  pageSize: number;
  canManagePayments: boolean;
  canManageOrders: boolean;
  canManageLogistics: boolean;
  canGenerateInvoices: boolean;
  canCancelInvoices: boolean;
  canCorrectInvoices: boolean;
  canViewFinancialData: boolean;
  activeTask?: { id: string; label: string } | null;
};

const paymentLabels: Record<string, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
};

const reservationStatusLabels: Record<string, string> = {
  not_required: "No aplica",
  reserved: "Reservado",
  confirmed: "Convertido en venta",
  released: "Liberado",
  expired: "Vencido",
  canceled: "Cancelado",
};

const fiscalCorrectionFieldLabels: Record<FiscalCorrectionValueKey, string> = {
  customer_name: "Nombre fiscal",
  customer_rtn: "RTN",
  customer_phone: "Teléfono",
  customer_email: "Correo",
  customer_address: "Dirección fiscal",
};

const fiscalCorrectionWarning =
  "Esta acción actualizará datos fiscales del cliente. Si la factura ya fue emitida, conservará el mismo número fiscal y quedará registrada en auditoría.";

export function AdminOrdersManager({
  orders,
  total,
  page,
  pageSize,
  canManagePayments,
  canManageOrders,
  canManageLogistics,
  canGenerateInvoices,
  canCancelInvoices,
  canCorrectInvoices,
  canViewFinancialData,
  activeTask = null,
}: AdminOrdersManagerProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState(orders[0]?.id ?? "");
  const [orderToCancel, setOrderToCancel] = useState<AdminOrderRow | null>(null);
  const [paymentToReject, setPaymentToReject] = useState<AdminOrderRow | null>(null);
  const [invoiceToCancel, setInvoiceToCancel] = useState<AdminOrderRow | null>(null);
  const [orderToCorrectFiscalData, setOrderToCorrectFiscalData] = useState<AdminOrderRow | null>(null);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
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

  function generateInvoice(order: AdminOrderRow) {
    if (!canIssueInvoice(order)) {
      showAdminMessage("No se puede emitir factura: valida pago confirmado, pedido activo e inventario no liberado.", false);
      return;
    }

    startTransition(async () => {
      const result = await generateInvoiceFromOrderAction(order.id);
      showAdminMessage(result.message, result.ok);
      if (result.ok && result.invoice) {
        await exportAdminInvoicePdf(result.invoice);
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

  function updateOrderStatus(order: AdminOrderRow, status: AdminOrderRow["status"], reason = "") {
    startTransition(async () => {
      const result = await updateOrderStatusAction(order.id, status, reason);
      showAdminMessage(result.message ?? "Estado del pedido actualizado.", result.ok);
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

      const result = await logInvoiceReprintAction(order.invoice_id ?? "");
      showAdminMessage(result.message, result.ok);
      if (result.ok) {
        await exportAdminInvoicePdf(detail.invoice);
        router.refresh();
      }
    });
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
    customerPhone: string;
    customerEmail: string;
    customerAddress: string;
    correctionReason: string;
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
              placeholder="Buscar por pedido, cliente, telefono, referencia o factura"
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

      <section className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <div className="rounded-lg border border-black/10 bg-white">
          <div className="border-b border-black/10 p-4">
            <h2 className="font-semibold">Pedidos</h2>
            <p className="mt-1 text-sm text-black/55">{filteredOrders.length.toLocaleString("es-HN")} pedidos en esta pagina</p>
          </div>
          <div className="divide-y divide-black/10">
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
                <p className="font-semibold">{order.order_number}</p>
                {order.tracking_code ? <p className="mt-1 text-xs text-[#b91c25]">{order.tracking_code}</p> : null}
                <p className="mt-1 text-sm text-black/55">{order.customer_name}</p>
                {canViewFinancialData ? <p className="mt-1 text-sm font-medium">{formatCurrency(order.total)}</p> : null}
                {canViewFinancialData && order.invoice_number ? (
                  <p className="mt-1 text-xs font-medium text-[#b91c25]">
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
            order={selectedOrder}
            canManagePayments={canManagePayments}
            canManageOrders={canManageOrders}
            canManageLogistics={canManageLogistics}
            canGenerateInvoices={canGenerateInvoices}
            canCancelInvoices={canCancelInvoices}
            canCorrectInvoices={canCorrectInvoices}
            canViewFinancialData={canViewFinancialData}
            isPending={isPending}
            message={message}
            onGenerateInvoice={() => generateInvoice(selectedOrder)}
            onApprovePayment={() => updatePaymentStatus(selectedOrder, "approved")}
            onRejectPayment={() => setPaymentToReject(selectedOrder)}
            onCancelOrder={() => setOrderToCancel(selectedOrder)}
            onCancelInvoice={() => setInvoiceToCancel(selectedOrder)}
            onCorrectFiscalData={() => setOrderToCorrectFiscalData(selectedOrder)}
            onUpdateOrderStatus={(status) => updateOrderStatus(selectedOrder, status)}
            onReprintInvoice={() => reprintInvoice(selectedOrder)}
          />
        ) : null}
      </section>

      {orderToCancel ? (
        <CancelOrderModal
          order={orderToCancel}
          isPending={isPending}
          onClose={() => setOrderToCancel(null)}
          onCancel={(reason) => {
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
          onCancel={(reason) => cancelInvoice(invoiceToCancel, reason)}
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
    </div>
  );
}

function canIssueInvoice(order: AdminOrderRow) {
  const paymentConfirmed = isPaymentConfirmed(order.payment_status);
  const normalizedStatus = canonicalOrderStatus(order.status);
  const orderReady = ["confirmado", "preparacion", "empacado", "enviado", "en_ruta", "entregado"].includes(normalizedStatus);
  const reservationReleased = ["released", "expired", "canceled"].includes(order.order_reservation_status);
  const activeInvoice = Boolean(order.invoice_number && !["anulada", "cancelled"].includes(String(order.invoice_status ?? "")));
  return paymentConfirmed && orderReady && normalizedStatus !== "cancelado" && !reservationReleased && !activeInvoice;
}

function OrderDetail({
  order,
  canManagePayments,
  canManageOrders,
  canManageLogistics,
  canGenerateInvoices,
  canCancelInvoices,
  canCorrectInvoices,
  canViewFinancialData,
  isPending,
  message,
  onGenerateInvoice,
  onApprovePayment,
  onRejectPayment,
  onCancelOrder,
  onCancelInvoice,
  onCorrectFiscalData,
  onUpdateOrderStatus,
  onReprintInvoice,
}: {
  order: AdminOrderRow;
  canManagePayments: boolean;
  canManageOrders: boolean;
  canManageLogistics: boolean;
  canGenerateInvoices: boolean;
  canCancelInvoices: boolean;
  canCorrectInvoices: boolean;
  canViewFinancialData: boolean;
  isPending: boolean;
  message: string;
  onGenerateInvoice: () => void;
  onApprovePayment: () => void;
  onRejectPayment: () => void;
  onCancelOrder: () => void;
  onCancelInvoice: () => void;
  onCorrectFiscalData: () => void;
  onUpdateOrderStatus: (status: AdminOrderRow["status"]) => void;
  onReprintInvoice: () => void;
}) {
  const normalizedStatus = canonicalOrderStatus(order.status);
  const isBankTransfer = order.payment_method === "bank_transfer";
  const isCash = order.payment_method === "cash";
  const isCard = order.payment_method === "card";
  const allowedStatuses = getAllowedOrderStatusOptions(order);
  const manualStatuses = allowedStatuses.filter((option) => option.value !== "cancelado");
  const paymentIsApproved = isPaymentConfirmed(order.payment_status);
  const paymentIsRejected = order.payment_status === "rejected";
  const invoiceCanBeIssued = canIssueInvoice(order);
  const invoiceIsCancelled = order.invoice_status === "anulada" || order.invoice_status === "cancelled";
  const hasActiveInvoice = Boolean(order.invoice_number && !invoiceIsCancelled);
  const canCancelOrder = normalizedStatus !== "cancelado" && allowedStatuses.some((option) => option.value === "cancelado");
  const canAcceptOrder = normalizedStatus === "recibido" && allowedStatuses.some((option) => option.value === "confirmado");
  const canConfirmPayment =
    canManagePayments &&
    !paymentIsApproved &&
    !paymentIsRejected &&
    !isCard &&
    normalizedStatus !== "cancelado" &&
    (isBankTransfer || (isCash && normalizedStatus === "entregado"));
  const paymentActionLabel = isCash ? "Confirmar pago recibido" : isBankTransfer ? "Confirmar pago" : "Confirmar por pasarela";
  const visibleManualStatuses = canManageOrders
    ? manualStatuses
    : manualStatuses.filter((option) => ["preparacion", "empacado", "enviado", "en_ruta", "entregado"].includes(option.value));
  const currentStatusOption = { value: normalizedStatus, label: orderStatusLabels[normalizedStatus] ?? String(normalizedStatus) };
  const safeManualStatuses = visibleManualStatuses.some((option) => option.value === normalizedStatus)
    ? visibleManualStatuses
    : [currentStatusOption, ...visibleManualStatuses];
  const nextStatusActionOptions = [
    { status: "preparacion", label: "Marcar en preparacion" },
    { status: "empacado", label: "Marcar empacado" },
    { status: "enviado", label: "Marcar enviado" },
    { status: "en_ruta", label: "Marcar en ruta" },
    { status: "entregado", label: "Marcar entregado" },
  ] satisfies Array<{ status: AdminOrderRow["status"]; label: string }>;
  const nextStatusActions = nextStatusActionOptions.filter((action) => allowedStatuses.some((option) => option.value === action.status));

  return (
    <article className="rounded-lg border border-black/10 bg-white">
      <div className="flex flex-col justify-between gap-3 border-b border-black/10 p-4 sm:flex-row sm:items-start">
        <div>
          <p className="text-sm text-black/50">{formatHnDateTime(order.created_at)}</p>
          <h2 className="mt-1 flex items-center gap-2 text-xl font-semibold">
            <PackageCheck size={22} />
            {order.order_number}
          </h2>
          <p className="mt-1 text-sm text-black/60">
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
        <CompactInfo label="Metodo de pago" value={paymentLabels[order.payment_method] ?? order.payment_method} />
        <CompactInfo label="Inventario" value={reservationStatusLabels[order.order_reservation_status] ?? order.order_reservation_status} />
        <CompactInfo label="Tracking" value={order.tracking_code ?? "Sin codigo"} />
        <CompactInfo label="Factura" value={order.invoice_number ? `${order.invoice_number}${invoiceIsCancelled ? " (anulada)" : ""}` : "Sin factura"} />
      </div>

      <div className="space-y-4 p-4">
        {normalizedStatus === "cancelado" ? (
          <div className="rounded-md border border-[#9b341b]/25 bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
            Este pedido esta cancelado. No requiere avance operativo.
          </div>
        ) : null}

        <div className="rounded-md border border-[#f59e0b]/30 bg-[#fffbeb] p-3">
          <p className="text-sm font-semibold text-[#7c2d12]">Accion recomendada</p>
          <p className="mt-1 text-sm text-[#7c2d12]">{recommendedOrderAction(order)}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <ContactActions phone={order.phone} customerName={order.customer_name} />
          {order.tracking_code ? (
            <button
              type="button"
              onClick={async () => navigator.clipboard.writeText(order.tracking_code ?? "")}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-medium"
            >
              <Copy size={15} />
              Copiar tracking
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {canManageOrders && canAcceptOrder ? (
            <Button onClick={() => onUpdateOrderStatus("confirmado")} disabled={isPending} variant="primary">
              <CheckCircle2 size={17} />
              Aceptar pedido
            </Button>
          ) : null}
          {canManageLogistics ? nextStatusActions.map((action) => (
            <Button key={action.status} onClick={() => onUpdateOrderStatus(action.status)} disabled={isPending} variant="ghost">
              <CheckCircle2 size={17} />
              {action.label}
            </Button>
          )) : null}
          {canConfirmPayment ? (
            <Button onClick={onApprovePayment} disabled={isPending} variant="primary">
              <CheckCircle2 size={17} />
              {isPending ? "Procesando..." : paymentActionLabel}
            </Button>
          ) : null}
          {canManagePayments && isBankTransfer && !paymentIsApproved && !paymentIsRejected && normalizedStatus !== "cancelado" ? (
            <Button onClick={onRejectPayment} disabled={isPending} variant="secondary">
              <XCircle size={17} />
              Rechazar pago
            </Button>
          ) : null}
          {canGenerateInvoices && !order.invoice_number ? (
            <Button onClick={onGenerateInvoice} disabled={isPending || !invoiceCanBeIssued} variant="dark">
              <FileText size={17} />
              {isPending ? "Generando..." : "Generar factura"}
            </Button>
          ) : null}
          {canViewFinancialData && order.invoice_number ? (
            <Button onClick={onReprintInvoice} variant="ghost">
              <Printer size={17} />
              {invoiceIsCancelled ? "Reimprimir anulada" : "Reimprimir factura"}
            </Button>
          ) : null}
          {canCancelInvoices && hasActiveInvoice ? (
            <Button onClick={onCancelInvoice} disabled={isPending} variant="secondary">
              <Ban size={17} />
              Anular factura
            </Button>
          ) : null}
          {canCorrectInvoices && canViewFinancialData ? (
            <Button onClick={onCorrectFiscalData} disabled={isPending || invoiceIsCancelled} variant="ghost">
              <FilePenLine size={17} />
              Editar datos fiscales
            </Button>
          ) : null}
          {canManageOrders && canCancelOrder ? (
            <Button onClick={onCancelOrder} disabled={isPending} variant="secondary">
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
            <CompactInfo label="Telefono" value={order.phone} />
            {order.tracking_code ? <CompactInfo label="Codigo" value={order.tracking_code} /> : null}
            {canViewFinancialData ? <CompactInfo label="RTN" value={order.fiscal_customer_rtn ?? "Sin RTN"} /> : null}
          </div>
        </div>

        {canViewFinancialData ? (
          <details className="rounded-md border border-black/10 bg-white p-3" open={isBankTransfer || Boolean(order.invoice_number)}>
            <summary className="cursor-pointer text-sm font-semibold">Detalles operativos y fiscales</summary>
            <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
              <CompactInfo label="Precio usado" value={order.price_mode === "wholesale" ? "Mayorista" : "Detalle"} />
              <CompactInfo label="Subtotal" value={formatCurrency(order.subtotal)} />
              <CompactInfo label="ISV" value={formatCurrency(order.tax)} />
              <CompactInfo label="Total" value={formatCurrency(order.total)} />
              <CompactInfo label="Envio" value={order.shipping_fee === 0 ? "Gratis" : formatCurrency(order.shipping_fee)} />
              <CompactInfo label="Contra entrega" value={formatCurrency(order.cash_on_delivery_fee)} />
              <CompactInfo label="Recargo minimo" value={formatCurrency(order.small_order_fee)} />
              <CompactInfo label="Descuentos" value={order.discount_total > 0 ? `-${formatCurrency(order.discount_total)}` : formatCurrency(0)} />
              <CompactInfo label="Otros cargos" value={formatCurrency(order.additional_fees.reduce((sum, fee) => sum + fee.amount, 0))} />
              <CompactInfo label="Nombre fiscal" value={order.fiscal_customer_name} />
              <CompactInfo label="RTN fiscal" value={order.fiscal_customer_rtn ?? "Sin RTN"} />
              <CompactInfo label="Direccion fiscal" value={order.fiscal_customer_address ?? "Sin direccion"} />
              <CompactInfo label="Factura fiscal" value={order.invoice_number ?? "Sin factura"} />
              <CompactInfo label="Estado factura" value={invoiceIsCancelled ? "Factura anulada" : order.invoice_number ? "Factura emitida" : "Sin factura"} />
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
                Factura anulada. Motivo: {order.invoice_cancellation_reason ?? "motivo registrado en auditoria"}.
              </p>
            ) : null}
          </details>
        ) : null}

        {canCorrectInvoices && canViewFinancialData ? <FiscalCorrectionHistory history={order.fiscal_correction_history} /> : null}

        {isCard && !paymentIsApproved ? (
          <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">
            Los pagos con tarjeta quedan pendientes hasta integrar una pasarela real; no se confirman manualmente.
          </p>
        ) : null}
        {isCash && !paymentIsApproved && normalizedStatus !== "entregado" && normalizedStatus !== "cancelado" ? (
          <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">
            El pago en efectivo se confirma despues de marcar el pedido como entregado.
          </p>
        ) : null}
        {canGenerateInvoices && !order.invoice_number && !invoiceCanBeIssued ? (
          <p className="rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
            La factura se habilita solo con pago confirmado, pedido activo e inventario no liberado.
          </p>
        ) : null}
        {message ? <p className="rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">{message}</p> : null}

        <div className="overflow-hidden rounded-lg border border-black/10">
          <div className="bg-[#e7e5e4] px-4 py-3 text-sm font-semibold">Productos</div>
          <div className="overflow-x-auto">
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
                    <td className="px-3 py-2">{item.product_name}</td>
                    <td className="px-3 py-2 text-black/55">{item.sku}</td>
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
            Validar tratamiento fiscal de envio y comision con la contadora.
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
  const [confirmation, setConfirmation] = useState("");
  const canSubmit = reason.trim().length >= 8 && confirmation.trim() === order.order_number;

  return (
    <ConfirmReasonModal
      title="Cancelar pedido"
      identifier={order.order_number}
      reasonLabel="Motivo de cancelacion"
      description="El pedido quedara como estado final y la reserva se liberara si aplica."
      icon={<XCircle size={18} />}
      reason={reason}
      confirmation={confirmation}
      isPending={isPending}
      canSubmit={canSubmit}
      submitLabel="Cancelar pedido"
      onReasonChange={setReason}
      onConfirmationChange={setConfirmation}
      onSubmit={() => onCancel(reason)}
      onClose={onClose}
    />
  );
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
    customerPhone: string;
    customerEmail: string;
    customerAddress: string;
    correctionReason: string;
  }) => void;
  onClose: () => void;
}) {
  const [customerName, setCustomerName] = useState(order.fiscal_customer_name);
  const [customerRtn, setCustomerRtn] = useState(order.fiscal_customer_rtn ?? "");
  const [customerPhone, setCustomerPhone] = useState(order.fiscal_customer_phone ?? order.phone ?? "");
  const [customerEmail, setCustomerEmail] = useState(order.fiscal_customer_email ?? order.email ?? "");
  const [customerAddress, setCustomerAddress] = useState(order.fiscal_customer_address ?? order.delivery_address ?? "");
  const [correctionReason, setCorrectionReason] = useState("");
  const [confirmingCorrection, setConfirmingCorrection] = useState(false);
  const normalizedRtn = customerRtn.trim().replace(/[\s-]/g, "");
  const rtnIsValid = normalizedRtn.length === 0 || /^\d{14}$/.test(normalizedRtn);
  const invoiceIsCancelled = order.invoice_status === "anulada" || order.invoice_status === "cancelled";
  const canSubmit = customerName.trim().length > 0 && correctionReason.trim().length >= 10 && rtnIsValid && !invoiceIsCancelled;

  function submitCorrection() {
    onCorrect({
      orderId: order.id,
      customerName,
      customerRtn,
      customerPhone,
      customerEmail,
      customerAddress,
      correctionReason,
    });
    setConfirmingCorrection(false);
  }

  return (
    <div className="cz-layer-modal fixed inset-0 overflow-y-auto bg-black/45 p-4">
      <section className="mx-auto my-8 max-w-3xl rounded-lg bg-white p-5 text-[#080808]">
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
          <Button onClick={onClose} variant="ghost">
            Cerrar
          </Button>
        </div>

        {invoiceIsCancelled ? (
          <p className="mt-5 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
            No se pueden corregir datos de una factura anulada.
          </p>
        ) : (
          <>
            <p className="mt-4 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
              {fiscalCorrectionWarning}
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Nombre / Razon social</span>
                <Input value={customerName} onChange={(event) => setCustomerName(event.target.value)} />
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">RTN del cliente</span>
                <Input value={customerRtn} onChange={(event) => setCustomerRtn(event.target.value)} placeholder="14 digitos o vacio" />
                {!rtnIsValid ? <p className="mt-1 text-xs font-medium text-[#b91c25]">El RTN debe contener 14 dígitos.</p> : null}
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Telefono</span>
                <Input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} />
              </label>
              <label>
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Correo</span>
                <Input value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} />
              </label>
              <label className="md:col-span-2">
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Direccion fiscal</span>
                <Input value={customerAddress} onChange={(event) => setCustomerAddress(event.target.value)} />
              </label>
              <label className="md:col-span-2">
                <span className="mb-1 block text-xs font-medium uppercase text-black/50">Motivo de correccion</span>
                <textarea
                  value={correctionReason}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                  className="min-h-24 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
                  placeholder="Ej. Cliente solicito corregir RTN."
                />
              </label>
            </div>
            {confirmingCorrection ? (
              <div className="mt-4 rounded-md border border-[#f59e0b]/35 bg-[#fffbeb] p-4 text-sm text-[#7c2d12]">
                <p>{fiscalCorrectionWarning}</p>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <Button onClick={() => setConfirmingCorrection(false)} variant="ghost">
                    Cancelar
                  </Button>
                  <Button onClick={submitCorrection} disabled={isPending || !canSubmit} variant="primary">
                    Guardar corrección
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button onClick={onClose} variant="ghost">
                Cancelar
              </Button>
              <Button
                onClick={() => setConfirmingCorrection(true)}
                disabled={isPending || !canSubmit}
                variant="primary"
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
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-3 py-2">Fecha</th>
                <th className="px-3 py-2">Usuario</th>
                <th className="px-3 py-2">Campo</th>
                <th className="px-3 py-2">Valor anterior</th>
                <th className="px-3 py-2">Valor nuevo</th>
                <th className="px-3 py-2">Motivo</th>
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
                    <td className="px-3 py-2">{entry.correction_reason ?? "-"}</td>
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
      description="El pago rechazado cancelara el pedido y liberara la reserva segun la logica de inventario."
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
  const [confirmation, setConfirmation] = useState("");
  const invoiceNumber = order.invoice_number ?? "";
  const canSubmit = reason.trim().length >= 8 && confirmation.trim() === invoiceNumber;

  return (
    <ConfirmReasonModal
      title="Anular factura"
      identifier={invoiceNumber}
      reasonLabel="Motivo de anulacion"
      description="No se elimina la factura: conserva numero fiscal, CAI, fecha, motivo y auditoria."
      icon={<Ban size={18} />}
      reason={reason}
      confirmation={confirmation}
      isPending={isPending}
      canSubmit={canSubmit}
      submitLabel="Anular factura"
      onReasonChange={setReason}
      onConfirmationChange={setConfirmation}
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
  icon: React.ReactNode;
  reason: string;
  confirmation: string;
  isPending: boolean;
  canSubmit: boolean;
  submitLabel: string;
  onReasonChange: (value: string) => void;
  onConfirmationChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div className="cz-layer-modal fixed inset-0 overflow-y-auto bg-black/45 p-4">
      <section className="mx-auto my-10 max-w-xl rounded-lg bg-white p-5 text-[#080808]">
        <div className="border-b border-black/10 pb-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-[#9b341b]">
            {icon}
            {title}
          </p>
          <h2 className="mt-1 text-2xl font-semibold">{identifier}</h2>
          <p className="mt-2 text-sm text-black/60">{description}</p>
        </div>
        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium uppercase text-black/50">{reasonLabel}</span>
          <textarea
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            className="min-h-28 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
          />
        </label>
        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-medium uppercase text-black/50">Confirmacion fuerte</span>
          <input
            value={confirmation}
            onChange={(event) => onConfirmationChange(event.target.value)}
            placeholder={`Escribe ${identifier}`}
            className="w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
          />
        </label>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cerrar
          </Button>
          <Button onClick={onSubmit} disabled={isPending || !canSubmit} variant="secondary">
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
      <p className="mt-1 truncate font-medium" title={value}>
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

  return <span className={`w-fit rounded-md px-3 py-2 text-sm font-medium ${classes[tone]}`}>{children}</span>;
}
