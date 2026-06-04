"use client";

import type { StoreInvoice } from "@/types/invoices";
import { downloadFiscalInvoicePdf, generateFiscalInvoicePdf } from "@/utils/fiscal-invoice-pdf";
import { storeInvoiceToOfficialInvoice } from "@/utils/invoice-document-mappers";

export async function generateInvoicePdf(invoice: StoreInvoice) {
  return generateFiscalInvoicePdf(storeInvoiceToOfficialInvoice(invoice));
}

export async function downloadInvoicePdf(invoice: StoreInvoice) {
  await downloadFiscalInvoicePdf(storeInvoiceToOfficialInvoice(invoice));
}
