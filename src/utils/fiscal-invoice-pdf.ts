"use client";

import type jsPDF from "jspdf";
import { formatHnDate, formatHnDateTime } from "@/utils/format";
import { additionalFeesTotal } from "@/utils/financial-summary";
import { createPdfDocument, getLastAutoTableY } from "@/utils/pdf-client";
import { formatCurrency } from "@/utils/pricing";
import type { AdditionalFee } from "@/types/financial";

export type FiscalInvoicePdfItem = {
  sku: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

export type FiscalInvoicePdfInput = {
  invoiceNumber: string;
  orderNumber: string;
  status: string;
  issuedAt: string | null;
  dueAt: string | null;
  createdAt: string | null;
  companyLegalName: string | null;
  companyRtn: string | null;
  companyAddress: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
  companyLogoUrl: string | null;
  cai: string | null;
  fiscalRangeStart: string | null;
  fiscalRangeEnd: string | null;
  fiscalDeadline: string | null;
  customerName: string;
  customerRtn: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  paymentMethod: string;
  paymentStatus: string | null;
  paymentReference: string | null;
  transferReceiptUrl?: string | null;
  subtotal: number;
  tax: number;
  shippingFee: number;
  cashOnDeliveryFee: number;
  smallOrderFee?: number;
  discountTotal?: number;
  additionalFees?: AdditionalFee[];
  total: number;
  items: FiscalInvoicePdfItem[];
  notes?: string | null;
};

const marginX = 14;
const pageWidth = 210;
const pageHeight = 297;
const red: [number, number, number] = [228, 37, 44];
const black: [number, number, number] = [8, 8, 8];
const gray: [number, number, number] = [244, 244, 245];

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

function valueOrDash(value: string | null | undefined) {
  return value && value.trim() ? value.trim() : "-";
}

function statusLabel(status: string) {
  if (status === "anulada" || status === "cancelled") {
    return "ANULADA";
  }

  if (status === "pendiente" || status === "draft") {
    return "PENDIENTE";
  }

  return "EMITIDA";
}

function paymentLabel(method: string) {
  if (method === "bank_transfer" || method === "Transferencia bancaria") {
    return "Transferencia bancaria";
  }

  if (method === "card" || method === "Tarjeta") {
    return "Tarjeta";
  }

  if (method === "cash" || method === "Efectivo") {
    return "Efectivo";
  }

  return method || "-";
}

const units = [
  "",
  "uno",
  "dos",
  "tres",
  "cuatro",
  "cinco",
  "seis",
  "siete",
  "ocho",
  "nueve",
  "diez",
  "once",
  "doce",
  "trece",
  "catorce",
  "quince",
  "dieciseis",
  "diecisiete",
  "dieciocho",
  "diecinueve",
];
const tens = ["", "", "veinte", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const hundreds = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

function amountChunkToWords(value: number): string {
  if (value === 0) {
    return "";
  }

  if (value === 100) {
    return "cien";
  }

  if (value < 20) {
    return units[value];
  }

  if (value < 30) {
    return value === 20 ? "veinte" : `veinti${units[value - 20]}`;
  }

  if (value < 100) {
    const ten = Math.floor(value / 10);
    const unit = value % 10;
    return unit ? `${tens[ten]} y ${units[unit]}` : tens[ten];
  }

  const hundred = Math.floor(value / 100);
  const remainder = value % 100;
  return `${hundreds[hundred]} ${amountChunkToWords(remainder)}`.trim();
}

function amountToSpanishWords(amount: number) {
  const fixedAmount = Math.max(0, Math.round(amount * 100) / 100);
  const integer = Math.floor(fixedAmount);
  const cents = Math.round((fixedAmount - integer) * 100);

  if (integer === 0) {
    return `CERO LEMPIRAS CON ${String(cents).padStart(2, "0")}/100`;
  }

  const millions = Math.floor(integer / 1_000_000);
  const thousands = Math.floor((integer % 1_000_000) / 1000);
  const remainder = integer % 1000;
  const parts: string[] = [];

  if (millions) {
    parts.push(millions === 1 ? "un millon" : `${amountChunkToWords(millions)} millones`);
  }

  if (thousands) {
    parts.push(thousands === 1 ? "mil" : `${amountChunkToWords(thousands)} mil`);
  }

  if (remainder) {
    parts.push(amountChunkToWords(remainder));
  }

  return `${parts.join(" ").toUpperCase()} LEMPIRAS CON ${String(cents).padStart(2, "0")}/100`;
}

function drawLabelValue(doc: jsPDF, label: string, value: string, x: number, y: number, maxWidth: number) {
  doc.setFont("helvetica", "bold");
  doc.text(`${label}:`, x, y);
  doc.setFont("helvetica", "normal");
  const lines = doc.splitTextToSize(value, maxWidth);
  doc.text(lines, x + 30, y);
  return y + Math.max(5, lines.length * 4.5);
}

function drawFooter(doc: jsPDF, printDate: string) {
  const pageCount = doc.getNumberOfPages();

  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(210, 210, 210);
    doc.line(marginX, pageHeight - 18, pageWidth - marginX, pageHeight - 18);
    doc.setFontSize(7);
    doc.setTextColor(70, 70, 70);
    doc.text("LA FACTURA ES BENEFICIO DE TODOS, EXIJALA", marginX, pageHeight - 13);
    doc.text("Original: Cliente - Copia 1: Obligado Tributario Emisor - Copia 2: Archivo", marginX, pageHeight - 9);
    doc.text(`Documento generado por Car Zone Accesorios. Fecha de impresion: ${printDate}`, marginX, pageHeight - 5);
    doc.text(`${page}/${pageCount}`, pageWidth - marginX, pageHeight - 5, { align: "right" });
  }

  doc.setTextColor(0, 0, 0);
}

function drawCancelledWatermark(doc: jsPDF, invoice: FiscalInvoicePdfInput) {
  if (invoice.status !== "anulada" && invoice.status !== "cancelled") {
    return;
  }

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setTextColor(155, 52, 27);
    doc.setFontSize(34);
    doc.setFont("helvetica", "bold");
    doc.text("FACTURA ANULADA", pageWidth / 2, 150, { align: "center", angle: -20 });
  }

  doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "normal");
}

export async function generateFiscalInvoicePdf(invoice: FiscalInvoicePdfInput) {
  const { doc, autoTable } = await createPdfDocument();
  const printDate = formatHnDateTime(new Date().toISOString());
  const logoDataUrl = await imageUrlToDataUrl(invoice.companyLogoUrl);
  const companyName = invoice.companyLegalName || "Car Zone Accesorios";
  const companyRtn = invoice.companyRtn || "-";
  const issuedDate = formatHnDate(invoice.issuedAt ?? invoice.createdAt);
  const dueDate = formatHnDate(invoice.dueAt);
  const fiscalDeadline = formatHnDate(invoice.fiscalDeadline ?? invoice.dueAt);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);

  if (logoDataUrl) {
    doc.addImage(logoDataUrl, imageFormatFromDataUrl(logoDataUrl), marginX, 10, 30, 20);
  }

  const companyX = logoDataUrl ? 49 : marginX;
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.text(companyName, companyX, 14);
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  const companyLines = [
    `RTN: ${companyRtn}`,
    `CAI: ${valueOrDash(invoice.cai)}`,
    `Direccion establecimiento: ${valueOrDash(invoice.companyAddress)}`,
    `Rango autorizado: ${valueOrDash(invoice.fiscalRangeStart)} a ${valueOrDash(invoice.fiscalRangeEnd)}`,
    `Vendedor: -`,
    `Fecha limite de emision: ${fiscalDeadline}`,
    `Direccion casa matriz: ${valueOrDash(invoice.companyAddress)}`,
    `Telefono: ${valueOrDash(invoice.companyPhone)} | Correo: ${valueOrDash(invoice.companyEmail)}`,
  ];
  companyLines.forEach((line, index) => {
    const wrapped = doc.splitTextToSize(line, 95);
    doc.text(wrapped[0] ?? line, companyX, 20 + index * 4.2);
  });

  doc.setFillColor(...black);
  doc.rect(148, 10, 48, 13, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("FACTURA", 172, 18.5, { align: "center" });
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.text(`No. ${invoice.invoiceNumber}`, 148, 29);
  doc.text(`Pedido: ${invoice.orderNumber}`, 148, 34);
  doc.text(`Fecha emision: ${issuedDate}`, 148, 39);
  doc.text(`Fecha vencimiento: ${dueDate}`, 148, 44);
  doc.text(`Estado: ${statusLabel(invoice.status)}`, 148, 49);

  doc.setDrawColor(210, 210, 210);
  doc.line(marginX, 55, pageWidth - marginX, 55);

  doc.setFillColor(...gray);
  doc.roundedRect(marginX, 60, pageWidth - marginX * 2, 28, 2, 2, "F");
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.text("Datos del cliente", marginX + 3, 66);
  doc.setFontSize(8);
  const customerY = drawLabelValue(doc, "Cliente", valueOrDash(invoice.customerName), marginX + 3, 72, 62);
  drawLabelValue(doc, "RTN", valueOrDash(invoice.customerRtn ?? "Consumidor final"), marginX + 3, customerY, 62);
  drawLabelValue(doc, "Direccion", valueOrDash(invoice.customerAddress), 106, 72, 62);
  drawLabelValue(doc, "Contacto", `${valueOrDash(invoice.customerPhone)} | ${valueOrDash(invoice.customerEmail)}`, 106, 78, 62);

  autoTable(doc, {
    startY: 96,
    margin: { left: marginX, right: marginX, bottom: 24 },
    head: [["Cantidad", "Codigo / SKU", "Descripcion", "Precio unitario", "Subtotal"]],
    body: invoice.items.map((item) => [
      item.quantity.toLocaleString("es-HN"),
      valueOrDash(item.sku),
      item.name,
      formatCurrency(item.unitPrice),
      formatCurrency(item.lineTotal),
    ]),
    styles: { fontSize: 8, cellPadding: 2.2, overflow: "linebreak" },
    headStyles: { fillColor: red, textColor: [255, 255, 255], fontStyle: "bold" },
    columnStyles: {
      0: { halign: "center", cellWidth: 20 },
      1: { cellWidth: 30 },
      2: { cellWidth: 72 },
      3: { halign: "right", cellWidth: 30 },
      4: { halign: "right", cellWidth: 30 },
    },
  });

  let finalY = getLastAutoTableY(doc, 104) + 8;
  if (finalY > 210) {
    doc.addPage();
    finalY = 18;
  }

  const observations = [
    `Metodo de pago: ${paymentLabel(invoice.paymentMethod)}`,
    invoice.paymentReference ? `Referencia bancaria: ${invoice.paymentReference}` : null,
    invoice.transferReceiptUrl ? "Comprobante de transferencia: recibido." : null,
    invoice.notes ? `Notas: ${invoice.notes}` : null,
    `Total en letras: ${amountToSpanishWords(invoice.total)}`,
  ].filter(Boolean) as string[];

  doc.setFillColor(...gray);
  doc.roundedRect(marginX, finalY, 105, 44, 2, 2, "F");
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.text("Observaciones", marginX + 3, finalY + 6);
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  let obsY = finalY + 12;
  observations.forEach((line) => {
    const wrapped = doc.splitTextToSize(line, 96);
    doc.text(wrapped, marginX + 3, obsY);
    obsY += wrapped.length * 4.2;
  });

  const totalsX = 126;
  const totalsY = finalY;
  const otherFees = additionalFeesTotal(invoice.additionalFees ?? []);
  const totalRows = [
    ["Subtotal productos", invoice.subtotal],
    ["ISV", invoice.tax],
    ["Costo de envio", invoice.shippingFee],
    ["Cargo contra entrega", invoice.cashOnDeliveryFee],
    ["Recargo pedido minimo", invoice.smallOrderFee ?? 0],
    ["Descuentos", -(invoice.discountTotal ?? 0)],
    ["Otros cargos", otherFees],
  ];
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.text("RESUMEN FINANCIERO", totalsX, totalsY - 2);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.8);
  totalRows.forEach(([label, amount], index) => {
    const y = totalsY + 4 + index * 4.6;
    doc.text(String(label), totalsX, y);
    doc.text(formatCurrency(Number(amount)), pageWidth - marginX, y, { align: "right" });
  });
  doc.setDrawColor(...black);
  doc.line(totalsX, totalsY + 38, pageWidth - marginX, totalsY + 38);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("TOTAL", totalsX, totalsY + 45);
  doc.text(formatCurrency(invoice.total), pageWidth - marginX, totalsY + 45, { align: "right" });
  doc.setFont("helvetica", "normal");

  const fiscalY = finalY + 55;
  doc.setFontSize(8);
  doc.text(`Metodo de pago: ${paymentLabel(invoice.paymentMethod)}`, marginX, fiscalY);
  doc.text("Numero de orden de compra exenta: -", marginX, fiscalY + 5);
  doc.text("Numero de constancia de registro de exonerados: -", marginX, fiscalY + 10);
  doc.text("Numero de registro de SAG: -", marginX, fiscalY + 15);

  drawCancelledWatermark(doc, invoice);
  drawFooter(doc, printDate);

  return doc;
}

export async function downloadFiscalInvoicePdf(invoice: FiscalInvoicePdfInput) {
  const doc = await generateFiscalInvoicePdf(invoice);
  doc.save(`${invoice.invoiceNumber}.pdf`);
}
