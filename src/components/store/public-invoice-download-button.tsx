"use client";

import { Download } from "lucide-react";
import type { StoreInvoice } from "@/types/invoices";
import { downloadInvoicePdf } from "@/utils/invoice-pdf";

export function PublicInvoiceDownloadButton({ invoice }: { invoice: StoreInvoice }) {
  return (
    <button
      type="button"
      onClick={() => downloadInvoicePdf(invoice)}
      className="inline-flex items-center justify-center gap-2 rounded-md bg-[#080808] px-3 py-2 text-sm font-medium text-white"
    >
      <Download size={16} />
      Descargar PDF
    </button>
  );
}

