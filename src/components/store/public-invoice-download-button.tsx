"use client";

import { Download, ExternalLink } from "lucide-react";
import type { StoreInvoice } from "@/types/invoices";

export function PublicInvoiceDownloadButton({ invoice }: { invoice: StoreInvoice }) {
  const pdfHref = `/api/cuenta/facturas/${encodeURIComponent(invoice.id)}/pdf`;

  return (
    <div className="grid w-full gap-2 sm:w-auto sm:grid-cols-2">
      <a
        href={pdfHref}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center justify-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-medium"
      >
        <ExternalLink size={16} />
        Abrir factura
      </a>
      <a
        href={`${pdfHref}?download=1`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center justify-center gap-2 rounded-md bg-[#080808] px-3 py-2 text-sm font-medium text-white"
      >
        <Download size={16} />
        Descargar PDF
      </a>
      <p className="text-xs leading-5 text-black/55 sm:col-span-2">
        Si la descarga no inicia automáticamente, abre la factura y usa Compartir o Guardar en tu navegador.
      </p>
    </div>
  );
}

