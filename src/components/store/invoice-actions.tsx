"use client";

import { Ban, Download, FileText, Printer } from "lucide-react";
import { useInvoices } from "@/contexts/invoices-context";
import { useToast } from "@/contexts/toast-context";
import type { StoreOrder } from "@/types/orders";
import { downloadInvoicePdf } from "@/utils/invoice-pdf";

export function InvoiceActions({ order }: { order: StoreOrder }) {
  const { createInvoice, findInvoiceByOrder, cancelInvoice } = useInvoices();
  const toast = useToast();
  const invoice = findInvoiceByOrder(order.orderNumber);

  function ensureInvoice() {
    return invoice ?? createInvoice({ order });
  }

  function downloadInvoice() {
    downloadInvoicePdf(ensureInvoice());
    toast.success("Factura reimpresa correctamente.");
  }

  async function cancelCurrentInvoice() {
    const currentInvoice = ensureInvoice();
    const confirmed = await toast.confirm({
      title: "Confirmar anulacion",
      message: `¿Anular factura ${currentInvoice.invoiceNumber}? Esta acción quedará registrada.`,
      confirmLabel: "Anular factura",
      cancelLabel: "Cancelar",
      tone: "danger",
    });

    if (!confirmed) {
      return;
    }
    cancelInvoice(currentInvoice.invoiceNumber);
    toast.success("Factura anulada correctamente.");
  }

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <button
        onClick={() => createInvoice({ order })}
        className="inline-flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-medium"
      >
        <FileText size={16} />
        {invoice ? "Factura generada" : "Generar factura"}
      </button>
      <button
        onClick={downloadInvoice}
        className="inline-flex items-center gap-2 rounded-md bg-[#1c1d1b] px-3 py-2 text-sm font-medium text-white"
      >
        <Download size={16} />
        Descargar PDF
      </button>
      <button
        onClick={downloadInvoice}
        className="inline-flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm font-medium"
      >
        <Printer size={16} />
        Reimprimir
      </button>
      <button
        onClick={cancelCurrentInvoice}
        className="inline-flex items-center gap-2 rounded-md border border-[#d55d3b]/30 px-3 py-2 text-sm font-medium text-[#9b341b]"
      >
        <Ban size={16} />
        Anular factura
      </button>
      {invoice ? (
        <span className="inline-flex items-center rounded-md bg-[#f7f7f2] px-3 py-2 text-sm">
          {invoice.invoiceNumber} / {invoice.status}
        </span>
      ) : null}
    </div>
  );
}
