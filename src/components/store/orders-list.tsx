import Link from "next/link";
import { FileText, PackageCheck, Route } from "lucide-react";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { PublicInvoiceDownloadButton } from "@/components/store/public-invoice-download-button";
import type { CustomerOrderRow } from "@/services/supabase/customer-account.service";
import type { StoreInvoice } from "@/types/invoices";
import { additionalFeesTotal } from "@/utils/financial-summary";
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
  card: "Tarjeta por link",
};

const reservationLabels: Record<string, string> = {
  not_required: "No aplica",
  reserved: "Activa",
  confirmed: "Confirmada",
  released: "Liberada",
  expired: "Vencida",
  canceled: "Cancelada",
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

  return "Factura pendiente. Disponible despues de confirmar el pago por link.";
}

function invoiceToStoreInvoice(order: CustomerOrderRow): StoreInvoice | null {
  const invoice = order.invoices.find((item) => ["emitida", "issued", "paid", "anulada", "cancelled"].includes(item.status)) ?? null;
  if (!invoice) {
    return null;
  }

  return {
    id: invoice.id,
    invoiceNumber: invoice.invoice_number,
    orderNumber: order.order_number,
    rtn: invoice.rtn ?? "",
    cai: invoice.cai ?? "",
    companyLegalName: invoice.company_legal_name,
    companyRtn: invoice.company_rtn ?? invoice.rtn ?? null,
    companyAddress: invoice.company_address,
    companyPhone: invoice.company_phone,
    companyEmail: invoice.company_email,
    companyLogoUrl: invoice.company_logo_url,
    fiscalRangeStart: invoice.fiscal_range_start,
    fiscalRangeEnd: invoice.fiscal_range_end,
    fiscalDeadline: invoice.due_at,
    customerName: invoice.customer_name ?? order.customer_name,
    customerRtn: invoice.customer_rtn,
    customerEmail: invoice.customer_email ?? order.email,
    customerPhone: invoice.customer_phone ?? order.phone,
    customerAddress: invoice.customer_address ?? order.delivery_address,
    items:
      invoice.invoice_items && invoice.invoice_items.length > 0
        ? invoice.invoice_items.map((item) => ({
            productId: item.id,
            sku: item.sku,
            name: item.product_name,
            quantity: Number(item.quantity),
            unitPrice: Number(item.unit_price),
            lineTotal: Number(item.line_total),
            retailPriceSnapshot: Number(item.retail_price_snapshot),
            wholesalePriceSnapshot: Number(item.wholesale_price_snapshot),
          }))
        : order.order_items.map((item) => ({
            productId: item.product_id ?? item.id,
            sku: item.sku,
            name: item.product_name,
            quantity: item.quantity,
            unitPrice: item.unit_price,
            lineTotal: item.line_total,
            retailPriceSnapshot: item.retail_price_snapshot,
            wholesalePriceSnapshot: item.wholesale_price_snapshot,
          })),
    subtotal: invoice.subtotal,
    isv: invoice.tax,
    shippingFee: invoice.shipping_fee,
    cashOnDeliveryFee: invoice.cash_on_delivery_fee,
    smallOrderFee: invoice.small_order_fee,
    discountTotal: invoice.discount_total,
    additionalFees: invoice.additional_fees,
    total: invoice.total,
    priceMode: invoice.price_mode ?? order.price_mode,
    paymentMethod:
      order.payment_method === "bank_transfer" ? "Transferencia bancaria" : order.payment_method === "card" ? "Tarjeta por link de pago" : "Efectivo",
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

            <div className="mt-4 grid gap-2 text-sm md:grid-cols-5">
              <Info label="Pago" value={paymentStatusLabels[order.payment_status ?? "pending"] ?? "Pendiente"} />
              <Info label="Método" value={paymentMethodLabels[order.payment_method] ?? order.payment_method} />
              <Info
                label="Reserva"
                value={order.reservation_review_required ? "Requiere revisión interna" : reservationLabels[order.order_reservation_status] ?? order.order_reservation_status}
              />
              <Info label="Total" value={formatCurrency(order.total)} strong />
              <Info label="Modo" value={order.price_mode === "wholesale" ? "Mayorista" : "Al detalle"} />
            </div>

            <FinancialSummary
              subtotal={order.subtotal}
              tax={order.tax}
              shippingFee={order.shipping_fee || order.shipping_total}
              cashOnDeliveryFee={order.cash_on_delivery_fee}
              smallOrderFee={order.small_order_fee}
              discountTotal={order.discount_total}
              additionalFeesValue={additionalFeesTotal(order.additional_fees)}
              total={order.total}
            />
            {order.cash_on_delivery_fee > 0 ? (
              <p className="mt-4 rounded-md bg-[#fff7ed] px-3 py-2 text-sm text-[#7c2d12]">
                Este pedido incluye tarifa contra entrega porque el pago se realizará al recibir.
              </p>
            ) : null}

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

function FinancialSummary({
  subtotal,
  tax,
  shippingFee,
  cashOnDeliveryFee,
  smallOrderFee,
  discountTotal,
  additionalFeesValue,
  total,
}: {
  subtotal: number;
  tax: number;
  shippingFee: number;
  cashOnDeliveryFee: number;
  smallOrderFee: number;
  discountTotal: number;
  additionalFeesValue: number;
  total: number;
}) {
  return (
    <div className="mt-4 rounded-md border border-black/10 bg-white p-3 text-sm">
      <p className="font-semibold">Resumen financiero</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Info label="Subtotal" value={formatCurrency(subtotal)} />
        <Info label="ISV" value={formatCurrency(tax)} />
        <Info label="Envio" value={shippingFee === 0 ? "Gratis" : formatCurrency(shippingFee)} />
        <Info label="Contra entrega" value={formatCurrency(cashOnDeliveryFee)} />
        <Info label="Recargo mínimo" value={formatCurrency(smallOrderFee)} />
        <Info label="Descuentos" value={discountTotal > 0 ? `-${formatCurrency(discountTotal)}` : formatCurrency(0)} />
        <Info label="Otros cargos" value={formatCurrency(additionalFeesValue)} />
        <Info label="Total final" value={formatCurrency(total)} strong />
      </div>
    </div>
  );
}


