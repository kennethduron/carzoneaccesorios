"use client";

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { StoreInvoice } from "@/types/invoices";
import { formatCurrency } from "@/utils/pricing";

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

export async function generateInvoicePdf(invoice: StoreInvoice) {
  const doc = new jsPDF();
  const statusText = invoice.status === "anulada" ? "ANULADA" : "EMITIDA";
  const companyName = invoice.companyLegalName || "Car Zone Accesorios";
  const companyRtn = invoice.companyRtn || invoice.rtn || "-";
  const logoDataUrl = await imageUrlToDataUrl(invoice.companyLogoUrl);
  const textStartX = logoDataUrl ? 54 : 14;

  if (logoDataUrl) {
    doc.addImage(logoDataUrl, imageFormatFromDataUrl(logoDataUrl), 14, 10, 32, 18);
  }

  doc.setFontSize(18);
  doc.text(companyName, textStartX, 18);
  doc.setFontSize(10);
  doc.text(`RTN empresa: ${companyRtn}`, textStartX, 26);
  doc.text(`CAI: ${invoice.cai || "-"}`, textStartX, 32);
  doc.text(`Rango autorizado desde: ${invoice.fiscalRangeStart ?? "-"}`, textStartX, 38);
  doc.text(`Rango autorizado hasta: ${invoice.fiscalRangeEnd ?? "-"}`, textStartX, 44);
  doc.text(
    `Fecha límite de emisión: ${
      invoice.fiscalDeadline ? new Date(invoice.fiscalDeadline).toLocaleDateString("es-HN") : "-"
    }`,
    textStartX,
    50,
  );
  doc.text(`Factura: ${invoice.invoiceNumber}`, textStartX, 56);
  doc.text(`Pedido: ${invoice.orderNumber}`, textStartX, 62);
  doc.text(`Fecha: ${new Date(invoice.issuedAt).toLocaleString("es-HN")}`, textStartX, 68);

  doc.setFontSize(14);
  doc.text(statusText, 160, 18);
  doc.setFontSize(10);
  doc.text(`Tipo de precio: ${invoice.priceMode === "wholesale" ? "precio mayorista" : "precio al detalle"}`, 14, 78);
  doc.text(`Cliente: ${invoice.customerName}`, 14, 84);
  doc.text(`RTN cliente: ${invoice.customerRtn ?? "Consumidor final"}`, 14, 90);
  doc.text(`Correo: ${invoice.customerEmail ?? "-"}`, 14, 96);
  doc.text(`Teléfono: ${invoice.customerPhone ?? "-"}`, 14, 102);
  doc.text(`Método de pago: ${invoice.paymentMethod}`, 14, 108);

  const tableStartY = invoice.paymentMethod === "Transferencia bancaria" && invoice.paymentReference ? 124 : 118;

  if (invoice.paymentMethod === "Transferencia bancaria" && invoice.paymentReference) {
    doc.text(`Referencia: ${invoice.paymentReference}`, 14, 114);
  }

  autoTable(doc, {
    startY: tableStartY,
    head: [["SKU", "Producto", "Cant.", "Precio", "Total"]],
    body: invoice.items.map((item) => [
      item.sku,
      item.name,
      item.quantity,
      formatCurrency(item.unitPrice),
      formatCurrency(item.lineTotal),
    ]),
  });

  const finalY = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 130;
  doc.text(`Subtotal: ${formatCurrency(invoice.subtotal)}`, 14, finalY + 12);
  doc.text(`ISV: ${formatCurrency(invoice.isv)}`, 14, finalY + 19);
  doc.text(`Envío: ${formatCurrency(invoice.shippingFee)}`, 14, finalY + 26);
  doc.text(`Comisión entrega: ${formatCurrency(invoice.cashOnDeliveryFee)}`, 14, finalY + 33);
  doc.text(`Total: ${formatCurrency(invoice.total)}`, 14, finalY + 40);

  if (invoice.status === "anulada") {
    doc.setTextColor(155, 52, 27);
    doc.setFontSize(34);
    doc.text("FACTURA ANULADA", 42, finalY + 58);
    doc.setTextColor(0, 0, 0);
  }

  return doc;
}

export async function downloadInvoicePdf(invoice: StoreInvoice) {
  const doc = await generateInvoicePdf(invoice);
  doc.save(`${invoice.invoiceNumber}.pdf`);
}
