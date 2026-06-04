"use client";

import {
  buildOfficialInvoiceHtml,
  officialInvoiceCss,
  type OfficialInvoiceInput,
} from "@/utils/official-invoice-document";

export function OfficialInvoiceDocument({ invoice }: { invoice: OfficialInvoiceInput }) {
  return (
    <div className="cz-official-invoice-host">
      <style>{officialInvoiceCss}</style>
      <div dangerouslySetInnerHTML={{ __html: buildOfficialInvoiceHtml(invoice) }} />
    </div>
  );
}
