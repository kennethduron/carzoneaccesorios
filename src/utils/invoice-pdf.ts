"use client";

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { StoreInvoice } from "@/types/invoices";
import { formatCurrency } from "@/utils/pricing";

export function generateInvoicePdf(invoice: StoreInvoice) {
  const doc = new jsPDF();
  const statusText = invoice.status === "anulada" ? "ANULADA" : "EMITIDA";

  doc.setFontSize(18);
  doc.text("Car Zone Accesorios", 14, 18);
  doc.setFontSize(10);
  doc.text(`RTN: ${invoice.rtn}`, 14, 26);
  doc.text(`CAI: ${invoice.cai}`, 14, 32);
  doc.text(`Factura: ${invoice.invoiceNumber}`, 14, 38);
  doc.text(`Pedido: ${invoice.orderNumber}`, 14, 44);
  doc.text(`Fecha: ${new Date(invoice.issuedAt).toLocaleString("es-HN")}`, 14, 50);

  doc.setFontSize(14);
  doc.text(statusText, 160, 18);
  doc.setFontSize(10);
  doc.text(`Tipo de precio: ${invoice.priceMode === "wholesale" ? "precio mayorista" : "precio al detalle"}`, 14, 60);
  doc.text(`Cliente: ${invoice.customerName}`, 14, 66);
  doc.text(`RTN cliente: ${invoice.customerRtn ?? "Consumidor final"}`, 14, 72);
  doc.text(`Método de pago: ${invoice.paymentMethod}`, 14, 78);
  const tableStartY = invoice.paymentMethod === "Transferencia bancaria" && invoice.paymentReference ? 94 : 88;

  if (invoice.paymentMethod === "Transferencia bancaria" && invoice.paymentReference) {
    doc.text(`Referencia: ${invoice.paymentReference}`, 14, 84);
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

  const finalY = (doc as jsPDF & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 90;
  doc.text(`Subtotal: ${formatCurrency(invoice.subtotal)}`, 14, finalY + 12);
  doc.text(`ISV: ${formatCurrency(invoice.isv)}`, 14, finalY + 19);
  doc.text(`Total: ${formatCurrency(invoice.total)}`, 14, finalY + 26);

  if (invoice.status === "anulada") {
    doc.setTextColor(155, 52, 27);
    doc.setFontSize(34);
    doc.text("FACTURA ANULADA", 42, finalY + 48);
    doc.setTextColor(0, 0, 0);
  }

  return doc;
}

export function downloadInvoicePdf(invoice: StoreInvoice) {
  generateInvoicePdf(invoice).save(`${invoice.invoiceNumber}.pdf`);
}
