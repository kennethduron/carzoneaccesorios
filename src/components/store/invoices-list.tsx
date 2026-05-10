"use client";

import { Ban, Download, Printer } from "lucide-react";
import { useInvoices } from "@/contexts/invoices-context";
import { downloadInvoicePdf } from "@/utils/invoice-pdf";
import { formatCurrency } from "@/utils/pricing";

export function InvoicesList() {
  const { invoices, cancelInvoice } = useInvoices();

  if (invoices.length === 0) {
    return (
      <div className="mt-6 rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">
        No hay facturas emitidas en esta sesión.
      </div>
    );
  }

  return (
    <div className="mt-6 grid gap-4">
      {invoices.map((invoice) => (
        <article key={invoice.id} className="rounded-lg border border-black/10 bg-white p-5">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div>
              <p className="text-sm text-black/50">{new Date(invoice.issuedAt).toLocaleString("es-HN")}</p>
              <h2 className="mt-1 text-xl font-semibold">{invoice.invoiceNumber}</h2>
              <p className="mt-2 text-sm text-black/60">
                RTN {invoice.rtn} / CAI {invoice.cai}
              </p>
              <p className="mt-1 text-sm text-black/60">Cliente: {invoice.customerName}</p>
            </div>
            <span className="w-fit rounded-md bg-[#f7f7f2] px-3 py-2 text-sm font-medium capitalize">
              {invoice.status}
            </span>
          </div>
          <div className="mt-4 grid gap-2 text-sm md:grid-cols-4">
            <p>Subtotal: {formatCurrency(invoice.subtotal)}</p>
            <p>ISV: {formatCurrency(invoice.isv)}</p>
            <p className="font-semibold">Total: {formatCurrency(invoice.total)}</p>
            <p>{invoice.priceMode === "wholesale" ? "precio mayorista" : "precio al detalle"}</p>
          </div>
          <div className="mt-3 rounded-md bg-[#f7f7f2] p-3 text-sm text-black/65">
            <p>Método de pago: {invoice.paymentMethod}</p>
            {invoice.paymentMethod === "Transferencia bancaria" && invoice.paymentReference ? (
              <p>Referencia: {invoice.paymentReference}</p>
            ) : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => downloadInvoicePdf(invoice)}
              className="inline-flex items-center gap-2 rounded-md bg-[#1c1d1b] px-3 py-2 text-sm font-medium text-white"
            >
              <Download size={16} />
              Descargar PDF
            </button>
            <button
              onClick={() => downloadInvoicePdf(invoice)}
              className="inline-flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-medium"
            >
              <Printer size={16} />
              Reimprimir
            </button>
            <button
              onClick={() => cancelInvoice(invoice.invoiceNumber)}
              className="inline-flex items-center gap-2 rounded-md border border-[#d55d3b]/30 px-3 py-2 text-sm font-medium text-[#9b341b]"
            >
              <Ban size={16} />
              Anular factura
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
