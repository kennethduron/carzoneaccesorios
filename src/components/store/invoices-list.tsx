import Link from "next/link";
import { FileText } from "lucide-react";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { PublicInvoiceDownloadButton } from "@/components/store/public-invoice-download-button";
import type { StoreInvoice } from "@/types/invoices";
import { additionalFeesTotal } from "@/utils/financial-summary";
import { formatCurrency } from "@/utils/pricing";

function isIssued(invoice: StoreInvoice) {
  return ["emitida", "issued", "paid", "anulada", "cancelled"].includes(invoice.status);
}

export function InvoicesList({
  invoices,
  focusInvoice,
  page,
  pageSize,
  total,
}: {
  invoices: StoreInvoice[];
  focusInvoice?: string;
  page?: number;
  pageSize?: number;
  total?: number;
}) {
  if (invoices.length === 0) {
    return (
      <div className="mt-6 rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">
        No hay facturas fiscales emitidas para tu cuenta. Estarán disponibles cuando el pago sea confirmado y la factura esté lista.
      </div>
    );
  }

  return (
    <div className="mt-6 grid gap-4">
      {page && pageSize && total !== undefined ? (
        <PaginationControls basePath="/facturas" page={page} pageSize={pageSize} total={total} label="facturas" params={{ factura: focusInvoice }} />
      ) : null}
      {invoices.map((invoice) => (
        <article
          key={invoice.id}
          className={`rounded-lg border bg-white p-5 ${
            focusInvoice === invoice.invoiceNumber ? "border-[#e4252c] shadow-md" : "border-black/10"
          }`}
        >
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div>
              <p className="text-sm text-black/50">{new Date(invoice.issuedAt).toLocaleString("es-HN")}</p>
              <h2 className="mt-1 flex items-center gap-2 text-xl font-semibold">
                <FileText size={20} />
                {invoice.invoiceNumber}
              </h2>
              <p className="mt-2 text-sm text-black/60">Pedido: {invoice.orderNumber}</p>
              <p className="mt-1 text-sm text-black/60">Cliente: {invoice.customerName}</p>
            </div>
            <span className="w-fit rounded-md bg-[#f4f4f5] px-3 py-2 text-sm font-medium capitalize">
              {invoice.status === "anulada" || invoice.status === "cancelled" ? "Anulada" : "Emitida"}
            </span>
          </div>

          <div className="mt-4 rounded-md border border-black/10 bg-white p-3 text-sm">
            <p className="font-semibold">Resumen financiero</p>
            <div className="mt-2 grid gap-2 md:grid-cols-4">
              <p>Subtotal: {formatCurrency(invoice.subtotal)}</p>
              <p>ISV: {formatCurrency(invoice.isv)}</p>
              <p>Envio: {invoice.shippingFee === 0 ? "Gratis" : formatCurrency(invoice.shippingFee)}</p>
              <p>Contra entrega: {formatCurrency(invoice.cashOnDeliveryFee)}</p>
              <p>Recargo mínimo: {formatCurrency(invoice.smallOrderFee)}</p>
              <p>Descuentos: {invoice.discountTotal > 0 ? `-${formatCurrency(invoice.discountTotal)}` : formatCurrency(0)}</p>
              <p>Otros cargos: {formatCurrency(additionalFeesTotal(invoice.additionalFees))}</p>
              <p className="font-semibold">Total: {formatCurrency(invoice.total)}</p>
            </div>
            <p className="mt-2 text-black/60">{invoice.priceMode === "wholesale" ? "Mayorista" : "Al detalle"}</p>
          </div>

          <div className="mt-3 rounded-md bg-[#f4f4f5] p-3 text-sm text-black/65">
            <p>Método de pago: {invoice.paymentMethod}</p>
            {invoice.paymentMethod === "Transferencia bancaria" && invoice.paymentReference ? (
              <p>Referencia: {invoice.paymentReference}</p>
            ) : null}
          </div>

          {isIssued(invoice) ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <PublicInvoiceDownloadButton invoice={invoice} />
              <Link
                href={`/mis-pedidos`}
                className="inline-flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-medium"
              >
                Ver pedido
              </Link>
            </div>
          ) : null}
          {invoice.status === "anulada" || invoice.status === "cancelled" ? (
            <p className="mt-4 rounded-md bg-[#fff7ed] px-3 py-2 text-sm text-[#7c2d12]">
              Factura anulada. El PDF se descarga con marca ANULADA.
            </p>
          ) : null}
        </article>
      ))}
      {page && pageSize && total !== undefined ? (
        <PaginationControls basePath="/facturas" page={page} pageSize={pageSize} total={total} label="facturas" params={{ factura: focusInvoice }} />
      ) : null}
    </div>
  );
}

