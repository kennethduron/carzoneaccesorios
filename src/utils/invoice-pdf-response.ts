import type { OfficialInvoiceInput } from "@/utils/official-invoice-document";
import { generateFiscalInvoicePdfArrayBuffer } from "@/utils/fiscal-invoice-pdf";

export function invoicePdfFileName(invoiceNumber: string) {
  const safeNumber = invoiceNumber.replace(/[^A-Za-z0-9._-]/g, "-");
  return `factura-${safeNumber}.pdf`;
}

export async function buildInvoicePdfResponse(invoice: OfficialInvoiceInput, disposition: "inline" | "attachment" = "inline") {
  const pdf = await generateFiscalInvoicePdfArrayBuffer(invoice);
  const fileName = invoicePdfFileName(invoice.invoiceNumber);

  return new Response(pdf, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
