import Link from "next/link";
import { FileText, PackageCheck, Route } from "lucide-react";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { PublicInvoiceDownloadButton } from "@/components/store/public-invoice-download-button";
import type { CustomerOrderRow } from "@/services/supabase/customer-account.service";
import type { StoreInvoice } from "@/types/invoices";
import { formatCurrency } from "@/utils/pricing";

const orderStatusLabels: Record<string, string> = {
  recibido: "Recibido",
  confirmado: "Confirmado",
  preparacion: "En preparacion",
  empacado: "Empacado",
  enviado: "Enviado",
  en_ruta: "En ruta",
  entregado: "Entregado",
  cancelado: "Cancelado",
  pending: "Recibido",
  confirmed: "Confirmado",
  paid: "Pago confirmado",
  preparing: "En preparacion",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

const paymentStatusLabels: Record<string, string> = {
  pending: "Pendiente",
  approved: "Confirmado",
  rejected: "Rechazado",
  refunded: "Reembolsado",
};

const paymentMethodLabels: Record<string, string> = {
  bank_transfer: "Transferencia",
  cash: "Efectivo",
  card: "Tarjeta",
};

function invoiceStatusMessage(order: CustomerOrderRow) {
  const invoice = order.invoices[0] ?? null;

  if (invoice?.status === "anulada" || invoice?.status === "cancelled") {
    return "Factura anulada. Contacta a la empresa.";
  }

  if (invoice && ["emitida", "issued", "paid"].includes(invoice.status)) {
    return null;
  }

  if (order.payment_method === "bank_transfer") {
    return "Factura pendiente. Estara disponible cuando la transferencia sea confirmada.";
  }

  if (order.payment_method === "cash") {
    return "Factura pendiente. Estara disponible cuando el pago sea confirmado.";
  }

  return "Factura pendiente. Disponible despues de confirmar pago.";
}

function invoiceToStoreInvoice(order: CustomerOrderRow): StoreInvoice | null {
  const invoice = order.invoices.find((item) => ["emitida", "issued", "paid"].includes(item.status)) ?? null;
  if (!invoice) {
    return null;
  }

  return {
    id: invoice.id,
    invoiceNumber: invoice.invoice_number,
    orderNumber: order.order_number,
    rtn: invoice.rtn ?? "",
    cai: invoice.cai ?? "",
    companyLegalName: null,
    companyRtn: invoice.rtn ?? null,
    companyAddress: null,
    companyPhone: null,
    companyEmail: null,
    companyLogoUrl: null,
    fiscalRangeStart: null,
    fiscalRangeEnd: null,
    fiscalDeadline: null,
    customerName: order.customer_name,
    customerRtn: invoice.customer_rtn,
    customerEmail: order.email,
    customerPhone: order.phone,
    customerAddress: order.delivery_address,
    items: order.order_items.map((item) => ({
      productId: item.product_id ?? item.id,
      sku: item.sku,
      name: item.product_name,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      lineTotal: item.line_total,
      retailPriceSnapshot: item.retail_price_snapshot,
      wholesalePriceSnapshot: item.wholesale_price_snapshot,
    })),
    subtotal: order.subtotal,
    isv: order.tax,
    shippingFee: order.shipping_total,
    cashOnDeliveryFee: 0,
    total: order.total,
    priceMode: order.price_mode,
    paymentMethod:
      order.payment_method === "bank_transfer" ? "Transferencia bancaria" : order.payment_method === "card" ? "Tarjeta" : "Efectivo",
    paymentReference: order.bank_reference_number,
    status: invoice.status,
    issuedAt: invoice.issued_at ?? order.created_at,
    cancelledAt: invoice.cancelled_at,
  };
}

export function OrdersList({
  orders,
  page,
  pageSize,
  total,
}: {
  orders: CustomerOrderRow[];
  page?: number;
  pageSize?: number;
  total?: number;
}) {
  if (orders.length === 0) {
    return (
      <div className="mt-6 rounded-lg border border-black/10 bg-white p-5">
        <p className="text-sm text-black/60">Tus pedidos aparecerán aquí cuando completes compras en la tienda.</p>
        <Link href="/catalogo" className="mt-4 inline-flex rounded-md bg-[#080808] px-4 py-2 text-sm font-medium text-white">
          Ver catálogo
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-6 grid gap-4">
      {page && pageSize && total !== undefined ? (
        <PaginationControls basePath="/mis-pedidos" page={page} pageSize={pageSize} total={total} label="pedidos" />
      ) : null}
      {orders.map((order) => {
        const issuedInvoice = invoiceToStoreInvoice(order);
        const pendingInvoiceMessage = invoiceStatusMessage(order);
        const trackingHref = order.tracking_code ? `/rastreo?codigo=${encodeURIComponent(order.tracking_code)}` : "/rastreo";

        return (
          <article key={order.id} className="rounded-lg border border-black/10 bg-white p-5">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <p className="text-sm text-black/50">{new Date(order.created_at).toLocaleString("es-HN")}</p>
                <h2 className="mt-1 flex items-center gap-2 text-xl font-semibold">
                  <PackageCheck size={20} />
                  Pedido: {order.order_number}
                </h2>
                <p className="mt-2 text-sm text-black/60">Código de rastreo: {order.tracking_code ?? "Pendiente"}</p>
              </div>
              <span className="w-fit rounded-md bg-[#fff1f2] px-3 py-2 text-sm font-medium text-[#b91c25]">
                {orderStatusLabels[order.status] ?? order.status}
              </span>
            </div>

            <div className="mt-4 grid gap-2 text-sm md:grid-cols-4">
              <Info label="Pago" value={paymentStatusLabels[order.payment_status ?? "pending"] ?? "Pendiente"} />
              <Info label="Método" value={paymentMethodLabels[order.payment_method] ?? order.payment_method} />
              <Info label="Total" value={formatCurrency(order.total)} strong />
              <Info label="Modo" value={order.price_mode === "wholesale" ? "Mayorista" : "Al detalle"} />
            </div>

            <div className="mt-4 divide-y divide-black/10 rounded-md border border-black/10">
              {order.order_items.map((item) => (
                <div key={`${order.id}-${item.id}`} className="flex justify-between gap-3 p-3 text-sm">
                  <span>
                    {item.quantity} x {item.product_name}
                  </span>
                  <span>{formatCurrency(item.line_total)}</span>
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href={trackingHref}
                className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-medium"
              >
                <Route size={16} />
                Ver estado del pedido
              </Link>
              {issuedInvoice ? (
                <>
                  <Link
                    href={`/facturas?factura=${encodeURIComponent(issuedInvoice.invoiceNumber)}`}
                    className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-medium"
                  >
                    <FileText size={16} />
                    Ver factura
                  </Link>
                  <PublicInvoiceDownloadButton invoice={issuedInvoice} />
                </>
              ) : null}
            </div>

            {pendingInvoiceMessage ? (
              <p className="mt-4 rounded-md bg-[#f4f4f5] px-3 py-2 text-sm text-black/60">{pendingInvoiceMessage}</p>
            ) : null}
          </article>
        );
      })}
      {page && pageSize && total !== undefined ? (
        <PaginationControls basePath="/mis-pedidos" page={page} pageSize={pageSize} total={total} label="pedidos" />
      ) : null}
    </div>
  );
}

function Info({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-md bg-[#f4f4f5] px-3 py-2">
      <p className="text-xs uppercase text-black/45">{label}</p>
      <p className={`mt-1 ${strong ? "font-semibold" : ""}`}>{value}</p>
    </div>
  );
}


