"use client";

import type { AdminInvoiceDetail } from "@/types/invoices";
import { downloadFiscalInvoicePdf } from "@/utils/fiscal-invoice-pdf";
import { adminInvoiceToOfficialInvoice } from "@/utils/invoice-document-mappers";

export async function exportAdminInvoicePdf(invoice: AdminInvoiceDetail) {
  await downloadFiscalInvoicePdf(adminInvoiceToOfficialInvoice(invoice));
}
