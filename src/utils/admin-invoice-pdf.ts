"use client";

import type { AdminInvoiceDetail } from "@/types/invoices";
import { formatHnDate } from "@/utils/format";
import { createPdfDocument, getLastAutoTableY } from "@/utils/pdf-client";
import { formatCurrency } from "@/utils/pricing";

const paymentLabels: Record<string, string> = {
  bank_transfer: "Transferencia bancaria",
  card: "Tarjeta",
  cash: "Efectivo",
};

async function imageUrlToDataUrl(url: string | null | undefined) {
  if (!url) {
    return null;
  }

  try {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) {
      return null;
    }

    const blob = await response.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function imageFormatFromDataUrl(dataUrl: string) {
  if (dataUrl.startsWith("data:image/png")) {
    return "PNG";
  }

  if (dataUrl.startsWith("data:image/webp")) {
    return "WEBP";
  }

  return "JPEG";
}

export async function exportAdminInvoicePdf(invoice: AdminInvoiceDetail) {
  const { doc, autoTable } = await createPdfDocument();
  const companyName = invoice.company_legal_name || "Car Zone Accesorios";
  const companyRtn = invoice.company_rtn || invoice.rtn || "-";
  const cai = invoice.cai || "-";
  const fiscalDeadline = invoice.due_at ? formatHnDate(invoice.due_at) : "-";
  const logoDataUrl = await imageUrlToDataUrl(invoice.company_logo_url);
  const textStartX = logoDataUrl ? 54 : 14;

  if (logoDataUrl) {
    doc.addImage(logoDataUrl, imageFormatFromDataUrl(logoDataUrl), 14, 10, 32, 18);
  }

  doc.setFontSize(14);
  doc.text(companyName, textStartX, 16);
  doc.setFontSize(9);
  doc.text(`RTN empresa: ${companyRtn}`, textStartX, 23);
  doc.text(`CAI: ${cai}`, textStartX, 29);
  doc.text(`Rango autorizado desde: ${invoice.fiscal_range_start ?? "-"}`, textStartX, 35);
  doc.text(`Rango autorizado hasta: ${invoice.fiscal_range_end ?? "-"}`, textStartX, 41);
  doc.text(`Fecha límite de emisión: ${fiscalDeadline}`, textStartX, 47);
  if (invoice.company_address) {
    doc.text(`Dirección fiscal: ${invoice.company_address}`, textStartX, 53);
  }

  doc.text(`Factura: ${invoice.invoice_number}`, 140, 16);
  doc.text(`Pedido: ${invoice.order_number}`, 140, 23);
  doc.text(`Fecha: ${formatHnDate(invoice.issued_at ?? invoice.created_at)}`, 140, 29);
  doc.text(`Estado: ${invoice.status}`, 140, 35);

  const customerStartY = invoice.company_address ? 65 : 59;
  doc.text(`Cliente: ${invoice.customer_name}`, 14, customerStartY);
  doc.text(`RTN cliente: ${invoice.customer_rtn ?? "Consumidor final"}`, 14, customerStartY + 6);
  doc.text(`Correo: ${invoice.customer_email ?? "-"}`, 14, customerStartY + 12);
  doc.text(`Teléfono: ${invoice.customer_phone ?? "-"}`, 14, customerStartY + 18);
  doc.text(`Dirección: ${invoice.customer_address ?? "-"}`, 14, customerStartY + 24);
  doc.text(`Pago: ${paymentLabels[invoice.payment_method] ?? invoice.payment_method}`, 14, customerStartY + 30);
  doc.text(`Estado del pago: ${invoice.payment_status ?? "-"}`, 14, customerStartY + 36);
  if (invoice.bank_reference_number) {
    doc.text(`Referencia bancaria: ${invoice.bank_reference_number}`, 14, customerStartY + 42);
  }

  autoTable(doc, {
    startY: invoice.bank_reference_number ? customerStartY + 50 : customerStartY + 44,
    head: [["SKU", "Producto", "Cantidad", "Precio", "Subtotal línea", "Total línea"]],
    body: invoice.items.map((item) => [
      item.sku,
      item.product_name,
      item.quantity,
      formatCurrency(item.unit_price),
      formatCurrency(item.line_total),
      formatCurrency(item.line_total),
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [228, 37, 44] },
  });

  const finalY = getLastAutoTableY(doc);
  doc.text(`Subtotal: ${formatCurrency(invoice.subtotal)}`, 140, finalY + 10);
  doc.text(`ISV: ${formatCurrency(invoice.tax)}`, 140, finalY + 16);
  doc.text(`Envío: ${formatCurrency(invoice.shipping_fee)}`, 140, finalY + 22);
  doc.text(`Comisión entrega: ${formatCurrency(invoice.cash_on_delivery_fee)}`, 140, finalY + 28);
  doc.text(`Total: ${formatCurrency(invoice.total)}`, 140, finalY + 34);
  doc.text("ISV por línea no se muestra; se conserva ISV fiscal a nivel factura.", 14, finalY + 34);

  if (invoice.status === "anulada" || invoice.status === "cancelled") {
    doc.setTextColor(155, 52, 27);
    doc.setFontSize(32);
    doc.text("FACTURA ANULADA", 42, finalY + 52);
    doc.setTextColor(0, 0, 0);
  }

  doc.save(`${invoice.invoice_number}.pdf`);
}
