"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ExternalLink, FileText, PackageCheck, Printer, Search, XCircle } from "lucide-react";
import { logInvoiceReprintAction } from "@/app/admin/facturas/actions";
import { generateInvoiceFromOrderAction, updateOrderPaymentStatusAction } from "@/app/admin/pedidos/actions";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { ContactActions } from "@/components/contact-actions";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { FiscalSettings } from "@/types/fiscal";
import type { AdminOrderRow } from "@/types/orders";
import { formatHnDate, formatHnDateTime } from "@/utils/format";
import { createPdfDocument, getLastAutoTableY } from "@/utils/pdf-client";
import { formatCurrency } from "@/utils/pricing";

type AdminOrdersManagerProps = {
  orders: AdminOrderRow[];
  total: number;
  page: number;
  pageSize: number;
  fiscalSettings: FiscalSettings;
  canManagePayments: boolean;
  canGenerateInvoices: boolean;
};

const orderStatusLabels: Record<string, string> = {
  recibido: "Recibido",
  confirmado: "Confirmado",
  preparacion: "Preparación",
  empacado: "Empacado",
  enviado: "Enviado",
  en_ruta: "En ruta",
  entregado: "Entregado",
  cancelado: "Cancelado",
  pending: "Pendiente",
  confirmed: "Confirmado",
  paid: "Pagado",
  preparing: "Preparación",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

const paymentStatusLabels: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobado",
  rejected: "Rechazado",
  refunded: "Reembolsado",
  pending_review: "Pendiente de revisión",
  confirmed: "Confirmado",
};

const paymentLabels: Record<string, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
};

export function AdminOrdersManager({
  orders,
  total,
  page,
  pageSize,
  fiscalSettings,
  canManagePayments,
  canGenerateInvoices,
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
      if (!normalizedQuery) {
        return true;
      }

      return `${order.order_number} ${order.customer_name} ${order.email ?? ""} ${order.phone} ${order.bank_reference_number ?? ""} ${order.invoice_number ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [debouncedQuery, orders]);

  const selectedOrder = useMemo(
    () => filteredOrders.find((order) => order.id === selectedOrderId) ?? filteredOrders[0] ?? orders[0] ?? null,
    [filteredOrders, orders, selectedOrderId],
  );

  function generateInvoice(order: AdminOrderRow) {
    startTransition(async () => {
      const result = await generateInvoiceFromOrderAction(order.id);
      showAdminMessage(result.message, result.ok);

      if (result.ok && result.invoiceNumber) {
        await exportGeneratedInvoicePdf(order, fiscalSettings, result.invoiceNumber, result.bankReference ?? order.bank_reference_number);
        router.refresh();
      }
    });
  }

  function updatePaymentStatus(order: AdminOrderRow, status: "approved" | "rejected") {
    startTransition(async () => {
      const result = await updateOrderPaymentStatusAction(order.id, status);
      showAdminMessage(result.message, result.ok);

      if (result.ok) {
        router.refresh();
      }
    });
  }

  function reprintInvoice(order: AdminOrderRow) {
    if (!order.invoice_id || !order.invoice_number) {
      return;
    }

    startTransition(async () => {
      const result = await logInvoiceReprintAction(order.invoice_id ?? "");
      showAdminMessage(result.message, result.ok);

      if (result.ok) {
        await exportGeneratedInvoicePdf(order, fiscalSettings, order.invoice_number ?? "", order.bank_reference_number);
        router.refresh();
      }
    });
  }

  if (orders.length === 0) {
    return (
      <section className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">
        No hay pedidos registrados en la base de datos.
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <PaginationControls basePath="/admin/pedidos" page={page} pageSize={pageSize} total={total} label="pedidos" />
      <section className="rounded-lg border border-black/10 bg-white p-4">
        <label className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2">
          <Search size={18} className="text-black/45" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar por pedido, cliente, teléfono, referencia o factura"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
      </section>
      <section className="grid gap-5 lg:grid-cols-[360px_1fr]">
        <div className="rounded-lg border border-black/10 bg-white">
          <div className="border-b border-black/10 p-4">
            <h2 className="font-semibold">Pedidos</h2>
            <p className="mt-1 text-sm text-black/55">{filteredOrders.length.toLocaleString("es-HN")} pedidos en esta pagina</p>
          </div>
          <div className="divide-y divide-black/10">
            {filteredOrders.length === 0 ? (
              <p className="p-4 text-sm text-black/55">No hay pedidos para mostrar.</p>
            ) : null}
            {filteredOrders.map((order) => (
              <button
                key={order.id}
                type="button"
                onClick={() => setSelectedOrderId(order.id)}
                className={`block w-full p-4 text-left transition-colors ${
                  selectedOrder?.id === order.id ? "bg-[#e8f3f2]" : "bg-white hover:bg-[#f7f7f2]"
                }`}
              >
                <p className="font-semibold">{order.order_number}</p>
                <p className="mt-1 text-sm text-black/55">{order.customer_name}</p>
                <p className="mt-1 text-sm font-medium">{formatCurrency(order.total)}</p>
                {order.invoice_number ? (
                  <p className="mt-1 text-xs font-medium text-[#1e5960]">Factura {order.invoice_number}</p>
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
            isPending={isPending}
            message={message}
            onGenerateInvoice={() => generateInvoice(selectedOrder)}
            onApprovePayment={() => updatePaymentStatus(selectedOrder, "approved")}
            onRejectPayment={() => updatePaymentStatus(selectedOrder, "rejected")}
            onReprintInvoice={() => reprintInvoice(selectedOrder)}
          />
        ) : null}
      </section>
    </div>
  );
}

function OrderDetail({
  order,
  canManagePayments,
  canGenerateInvoices,
  isPending,
  message,
  onGenerateInvoice,
  onApprovePayment,
  onRejectPayment,
  onReprintInvoice,
}: {
  order: AdminOrderRow;
  canManagePayments: boolean;
  canGenerateInvoices: boolean;
  isPending: boolean;
  message: string;
  onGenerateInvoice: () => void;
  onApprovePayment: () => void;
  onRejectPayment: () => void;
  onReprintInvoice: () => void;
}) {
  const isBankTransfer = order.payment_method === "bank_transfer";
  const paymentIsApproved = order.payment_status === "approved";
  const paymentIsRejected = order.payment_status === "rejected";

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
        <span className="w-fit rounded-md bg-[#e8f3f2] px-3 py-2 text-sm font-medium text-[#1e5960]">
          {orderStatusLabels[order.status] ?? order.status}
        </span>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <InfoBlock label="Método de pago" value={paymentLabels[order.payment_method] ?? order.payment_method} />
        <InfoBlock label="Estado del pago" value={paymentStatusLabels[order.payment_status ?? "pending"] ?? "Pendiente"} />
        <InfoBlock label="Precio usado" value={order.price_mode === "wholesale" ? "Precio mayorista" : "Precio al detalle"} />
        <InfoBlock label="RTN del cliente" value={order.customer_rtn ?? "Sin RTN"} />
        {order.invoice_number ? <InfoBlock label="Factura fiscal" value={order.invoice_number} /> : null}
        {isBankTransfer ? (
          <>
            <InfoBlock label="Número de referencia" value={order.bank_reference_number ?? "Sin referencia"} />
            <div className="rounded-lg border border-black/10 bg-[#f7f7f2] p-4">
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
                <p className="mt-2 text-sm text-black/65">No fue subido.</p>
              )}
            </div>
          </>
        ) : null}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {canGenerateInvoices && !order.invoice_number ? (
          <Button onClick={onGenerateInvoice} disabled={isPending} variant="dark">
            <FileText size={17} />
            {isPending ? "Generando..." : "Generar factura"}
          </Button>
        ) : null}
        {order.invoice_number ? (
          <Button
            onClick={onReprintInvoice}
            variant="ghost"
          >
            <Printer size={17} />
            Reimprimir factura
          </Button>
        ) : null}
        {canManagePayments ? (
          <>
            <Button onClick={onApprovePayment} disabled={isPending || paymentIsApproved} variant="primary">
              <CheckCircle2 size={17} />
              {isPending ? "Procesando..." : "Confirmar pago"}
            </Button>
            <Button onClick={onRejectPayment} disabled={isPending || paymentIsRejected} variant="secondary">
              <XCircle size={17} />
              {isPending ? "Procesando..." : "Rechazar pago"}
            </Button>
          </>
        ) : null}
      </div>
      {message ? <p className="mt-3 rounded-md bg-[#f7f7f2] p-3 text-sm text-black/60">{message}</p> : null}

      <div className="mt-5 overflow-hidden rounded-lg border border-black/10">
        <div className="bg-[#f0ede2] px-4 py-3 text-sm font-semibold">Productos</div>
        <div className="divide-y divide-black/10">
          {order.order_items.map((item) => (
            <div key={`${order.id}-${item.id}`} className="flex justify-between gap-3 p-4 text-sm">
              <span>
                {item.quantity} x {item.product_name}
                <span className="ml-2 text-black/45">({item.applied_price_mode === "wholesale" ? "mayorista" : "detalle"})</span>
              </span>
              <span className="font-medium">{formatCurrency(item.line_total)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-5 grid gap-2 text-sm md:grid-cols-3">
        <p>Subtotal: {formatCurrency(order.subtotal)}</p>
        <p>ISV: {formatCurrency(order.tax)}</p>
        <p className="font-semibold">Total: {formatCurrency(order.total)}</p>
      </div>
    </article>
  );
}

async function exportGeneratedInvoicePdf(
  order: AdminOrderRow,
  fiscalSettings: FiscalSettings,
  invoiceNumber: string,
  bankReference: string | null,
) {
  const { doc, autoTable } = await createPdfDocument();
  doc.setFontSize(14);
  doc.text(fiscalSettings.legal_name || "Car Zone Accesorios", 14, 16);
  doc.setFontSize(9);
  doc.text(`RTN: ${fiscalSettings.rtn || "-"}`, 14, 23);
  doc.text(`CAI: ${fiscalSettings.cai || "-"}`, 14, 29);
  doc.text(`Factura: ${invoiceNumber}`, 140, 16);
  doc.text(`Pedido: ${order.order_number}`, 140, 23);
  doc.text(`Fecha: ${formatHnDate(order.invoice_issued_at ?? order.created_at)}`, 140, 29);
  doc.text(`Cliente: ${order.customer_name}`, 14, 42);
  doc.text(`RTN cliente: ${order.customer_rtn ?? "-"}`, 14, 48);
  doc.text(`Teléfono: ${order.phone}`, 14, 54);
  doc.text(`Pago: ${paymentLabels[order.payment_method] ?? order.payment_method}`, 14, 60);
  doc.text(`Precio usado: ${order.price_mode === "wholesale" ? "precio mayorista" : "precio al detalle"}`, 14, 66);
  if (bankReference) {
    doc.text(`Referencia bancaria: ${bankReference}`, 14, 72);
  }

  autoTable(doc, {
    startY: bankReference ? 80 : 74,
    head: [["SKU", "Producto", "Cantidad", "Precio", "Total"]],
    body: order.order_items.map((item) => [
      item.sku,
      item.product_name,
      item.quantity,
      formatCurrency(item.unit_price),
      formatCurrency(item.line_total),
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [36, 106, 115] },
  });

  const finalY = getLastAutoTableY(doc);
  doc.text(`Subtotal: ${formatCurrency(order.subtotal)}`, 140, finalY + 10);
  doc.text(`ISV: ${formatCurrency(order.tax)}`, 140, finalY + 16);
  doc.text(`Total: ${formatCurrency(order.total)}`, 140, finalY + 22);
  doc.save(`${invoiceNumber}.pdf`);
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-[#f7f7f2] p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  );
}
