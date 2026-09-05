import type { InvoiceStatus } from "@/types/invoices";

const cancelledInvoiceStatuses = new Set<InvoiceStatus>(["anulada", "cancelled"]);

export function formatReceivableInvoice(invoiceNumber: string | null, invoiceStatus: InvoiceStatus | null) {
  if (!invoiceNumber) return "Sin factura";
  if (invoiceStatus && cancelledInvoiceStatuses.has(invoiceStatus)) {
    return `${invoiceNumber} · Factura anulada`;
  }
  return invoiceNumber;
}
