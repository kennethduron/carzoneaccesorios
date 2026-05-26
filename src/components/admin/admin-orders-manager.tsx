"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Copy, ExternalLink, FileText, PackageCheck, Printer, Search, XCircle } from "lucide-react";
import { getInvoiceDetailAction, logInvoiceReprintAction } from "@/app/admin/facturas/actions";
import { generateInvoiceFromOrderAction, updateOrderPaymentStatusAction, updateOrderStatusAction } from "@/app/admin/pedidos/actions";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { ContactActions } from "@/components/contact-actions";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
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
  canGenerateInvoices: boolean;
  canViewFinancialData: boolean;
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

export function AdminOrdersManager({
  orders,
  total,
  page,
  pageSize,
  canManagePayments,
  canGenerateInvoices,
  canViewFinancialData,
}: AdminOrdersManagerProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState(orders[0]?.id ?? "");
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
      return `${order.order_number} ${order.tracking_code ?? ""} ${order.customer_name} ${order.email ?? ""} ${order.phone} ${order.bank_reference_number ?? ""} ${order.invoice_number ?? ""}`
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
      showAdminMessage("No se puede emitir factura porque el pago aún no ha sido confirmado.", false);
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

  function updatePaymentStatus(order: AdminOrderRow, status: "approved" | "rejected") {
    const rejectionReason =
      status === "rejected"
        ? window.prompt("Motivo para rechazar el pago. Se liberará la reserva del pedido.")?.trim() ?? ""
        : "";

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

  function updateOrderStatus(order: AdminOrderRow, status: AdminOrderRow["status"]) {
    startTransition(async () => {
      const result = await updateOrderStatusAction(order.id, status);
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

  if (orders.length === 0) {
    return <section className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">No hay pedidos registrados.</section>;
  }

  return (
    <div className="space-y-5">
      <PaginationControls basePath="/admin/pedidos" page={page} pageSize={pageSize} total={total} label="pedidos" />
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

      <section className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <div className="rounded-lg border border-black/10 bg-white">
          <div className="border-b border-black/10 p-4">
            <h2 className="font-semibold">Pedidos</h2>
            <p className="mt-1 text-sm text-black/55">{filteredOrders.length.toLocaleString("es-HN")} pedidos en esta página</p>
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
                  <p className="mt-1 text-xs font-medium text-[#b91c25]">Factura {order.invoice_number}</p>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        {selectedOrder ? (
          <OrderDetail
            order={selectedOrder}
            canManagePayments={canManagePayments}
            canGenerateInvoices={canGenerateInvoices}
            canViewFinancialData={canViewFinancialData}
            isPending={isPending}
            message={message}
            onGenerateInvoice={() => generateInvoice(selectedOrder)}
            onApprovePayment={() => updatePaymentStatus(selectedOrder, "approved")}
            onRejectPayment={() => updatePaymentStatus(selectedOrder, "rejected")}
            onUpdateOrderStatus={(status) => updateOrderStatus(selectedOrder, status)}
            onReprintInvoice={() => reprintInvoice(selectedOrder)}
          />
        ) : null}
      </section>
    </div>
  );
}

function canIssueInvoice(order: AdminOrderRow) {
  const paymentConfirmed = isPaymentConfirmed(order.payment_status);
  const orderReady = ["confirmado", "preparacion", "empacado", "enviado", "en_ruta", "entregado"].includes(
    canonicalOrderStatus(order.status),
  );
  return paymentConfirmed && orderReady;
}

function OrderDetail({
  order,
  canManagePayments,
  canGenerateInvoices,
  canViewFinancialData,
  isPending,
  message,
  onGenerateInvoice,
  onApprovePayment,
  onRejectPayment,
  onUpdateOrderStatus,
  onReprintInvoice,
}: {
  order: AdminOrderRow;
  canManagePayments: boolean;
  canGenerateInvoices: boolean;
  canViewFinancialData: boolean;
  isPending: boolean;
  message: string;
  onGenerateInvoice: () => void;
  onApprovePayment: () => void;
  onRejectPayment: () => void;
  onUpdateOrderStatus: (status: AdminOrderRow["status"]) => void;
  onReprintInvoice: () => void;
}) {
  const normalizedStatus = canonicalOrderStatus(order.status);
  const isBankTransfer = order.payment_method === "bank_transfer";
  const isCash = order.payment_method === "cash";
  const isCard = order.payment_method === "card";
  const allowedStatuses = getAllowedOrderStatusOptions(order);
  const canAcceptOrder = normalizedStatus === "recibido" && allowedStatuses.some((option) => option.value === "confirmado");
  const canCancelOrder = normalizedStatus !== "cancelado" && allowedStatuses.some((option) => option.value === "cancelado");
  const paymentIsApproved = isPaymentConfirmed(order.payment_status);
  const paymentIsRejected = order.payment_status === "rejected";
  const invoiceCanBeIssued = canIssueInvoice(order);
  const paymentActionLabel = isCash ? "Confirmar pago recibido" : isBankTransfer ? "Confirmar pago" : "Confirmar por pasarela";

  return (
    <article className="rounded-lg border border-black/10 bg-white p-5">
      <div className="flex flex-col justify-between gap-3 border-b border-black/10 pb-4 sm:flex-row sm:items-start">
        <div>
          <p className="text-sm text-black/50">{formatHnDateTime(order.created_at)}</p>
          <h2 className="mt-1 flex items-center gap-2 text-2xl font-semibold">
            <PackageCheck size={22} />
            {order.order_number}
          </h2>
          <p className="mt-2 text-sm text-black/60">
            {order.customer_name} / {order.phone}
          </p>
          <ContactActions phone={order.phone} customerName={order.customer_name} className="mt-3" />
        </div>
        <span className="w-fit rounded-md bg-[#fff1f2] px-3 py-2 text-sm font-medium text-[#b91c25]">
          {orderStatusLabels[normalizedStatus] ?? order.status}
        </span>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <InfoBlock label="Método de pago" value={paymentLabels[order.payment_method] ?? order.payment_method} />
        <InfoBlock label="Estado del pago" value={paymentDisplayLabel(order)} />
        <InfoBlock label="Estado del pedido" value={orderStatusLabels[normalizedStatus] ?? order.status} />
        <InfoBlock label="Inventario" value={reservationStatusLabels[order.order_reservation_status] ?? order.order_reservation_status} />
        <div className="rounded-lg border border-[#f59e0b]/30 bg-[#fffbeb] p-4 md:col-span-2">
          <p className="text-sm font-semibold text-[#7c2d12]">Acción recomendada</p>
          <p className="mt-1 text-sm text-[#7c2d12]">{recommendedOrderAction(order)}</p>
        </div>

        <div className="rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
          <p className="text-sm text-black/50">Código de seguimiento</p>
          <div className="mt-2 flex items-center gap-2">
            <p className="font-semibold">{order.tracking_code ?? "Sin código"}</p>
            {order.tracking_code ? (
              <button
                type="button"
                onClick={async () => navigator.clipboard.writeText(order.tracking_code ?? "")}
                className="grid size-8 place-items-center rounded-md border border-black/10 bg-white"
                title="Copiar código"
                aria-label="Copiar código de seguimiento"
              >
                <Copy size={15} />
              </button>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
          <label>
            <span className="text-sm text-black/50">Estado del pedido</span>
            <select
              value={normalizedStatus}
              onChange={(event) => onUpdateOrderStatus(event.target.value as AdminOrderRow["status"])}
              disabled={isPending}
              className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
            >
              {allowedStatuses.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {canViewFinancialData ? (
          <>
            <InfoBlock label="Precio usado" value={order.price_mode === "wholesale" ? "Precio mayorista" : "Precio al detalle"} />
            <InfoBlock label="RTN del cliente" value={order.customer_rtn ?? "Sin RTN"} />
            {order.invoice_number ? <InfoBlock label="Factura fiscal" value={order.invoice_number} /> : null}
            {isBankTransfer ? (
              <>
                <div className="rounded-lg border border-[#e4252c]/25 bg-[#fff1f2] p-4">
                  <p className="text-sm text-[#7f1d1d]/70">Referencia bancaria</p>
                  <p className="mt-1 font-semibold text-[#7f1d1d]">{order.bank_reference_number ?? "Sin referencia"}</p>
                </div>
                <div className="rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
                  <p className="text-sm text-black/50">Comprobante</p>
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
              </>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {canAcceptOrder ? (
          <Button onClick={() => onUpdateOrderStatus("confirmado")} disabled={isPending} variant="primary">
            <CheckCircle2 size={17} />
            Aceptar pedido
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
            Reimprimir factura
          </Button>
        ) : null}
        {canViewFinancialData && order.invoice_number ? (
          <Link
            href="/admin/facturas"
            className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-medium"
          >
            <FileText size={17} />
            Corregir datos fiscales
          </Link>
        ) : null}
        {canManagePayments ? (
          <>
            <Button onClick={onApprovePayment} disabled={isPending || paymentIsApproved || isCard} variant="primary">
              <CheckCircle2 size={17} />
              {isPending ? "Procesando..." : paymentActionLabel}
            </Button>
            {isBankTransfer ? (
              <Button onClick={onRejectPayment} disabled={isPending || paymentIsRejected} variant="secondary">
                <XCircle size={17} />
                {isPending ? "Procesando..." : "Rechazar pago"}
              </Button>
            ) : null}
            {canCancelOrder ? (
              <Button onClick={() => onUpdateOrderStatus("cancelado")} disabled={isPending} variant="secondary">
                <XCircle size={17} />
                Cancelar pedido
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      {isCard && !paymentIsApproved ? (
        <p className="mt-3 rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">
          Los pagos con tarjeta se confirman únicamente mediante pasarela o webhook autorizado.
        </p>
      ) : null}
      {canGenerateInvoices && !order.invoice_number && !invoiceCanBeIssued ? (
        <p className="mt-3 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
          No se puede emitir factura porque el pago aún no ha sido confirmado.
        </p>
      ) : null}
      {message ? <p className="mt-3 rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">{message}</p> : null}

      <div className="mt-5 overflow-hidden rounded-lg border border-black/10">
        <div className="bg-[#e7e5e4] px-4 py-3 text-sm font-semibold">Productos</div>
        <div className="divide-y divide-black/10">
          {order.order_items.map((item) => (
            <div key={`${order.id}-${item.id}`} className="flex justify-between gap-3 p-4 text-sm">
              <span>
                {item.quantity} x {item.product_name}
                {canViewFinancialData ? (
                  <span className="ml-2 text-black/45">({item.applied_price_mode === "wholesale" ? "mayorista" : "detalle"})</span>
                ) : null}
              </span>
              {canViewFinancialData ? <span className="font-medium">{formatCurrency(item.line_total)}</span> : null}
            </div>
          ))}
        </div>
      </div>

      {canViewFinancialData ? (
        <>
          <p className="mt-5 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
            Validar tratamiento fiscal de envío y comisión con la contadora.
          </p>
          <div className="mt-5 grid gap-2 text-sm md:grid-cols-5">
            <p>Subtotal: {formatCurrency(order.subtotal)}</p>
            <p>ISV: {formatCurrency(order.tax)}</p>
            <p>Envío: {order.shipping_fee === 0 ? "Gratis" : formatCurrency(order.shipping_fee)}</p>
            <p>Pago al recibir: {formatCurrency(order.cash_on_delivery_fee)}</p>
            <p className="font-semibold">Total: {formatCurrency(order.total)}</p>
          </div>
        </>
      ) : null}
    </article>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-[#f4f4f5] p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  );
}
