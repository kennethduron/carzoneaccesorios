import type jsPDF from "jspdf";
import { createPdfDocument, getLastAutoTableY } from "@/utils/pdf-client";
import { formatCurrency } from "@/utils/pricing";
import {
  amountToSpanishWords,
  getOfficialInvoiceDates,
  getOfficialInvoiceLogoSrc,
  getOfficialInvoiceTotals,
  paymentLabel,
  statusLabel,
  summaryRows,
  valueOrDash,
  type OfficialInvoiceInput,
} from "@/utils/official-invoice-document";
import { formatHnDateTime } from "@/utils/format";

export type FiscalInvoicePdfItem = OfficialInvoiceInput["items"][number];
export type FiscalInvoicePdfInput = OfficialInvoiceInput;

const pageWidth = 210;
const pageHeight = 297;
const marginX = 10;
const black: [number, number, number] = [0, 0, 0];
const publicAssetBaseUrl = "https://carzoneaccesorios.com";

function resolveImageUrl(url: string) {
  if (url.startsWith("/") && !url.startsWith("//")) {
    if (typeof window !== "undefined") return url;
    return `${publicAssetBaseUrl}${url}`;
  }

  return url;
}

async function imageUrlToDataUrl(url: string | null | undefined) {
  if (!url) return null;

  try {
    const response = await fetch(resolveImageUrl(url), { cache: "force-cache" });
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const bytes = new Uint8Array(await response.arrayBuffer());
    return `data:${contentType};base64,${bytesToBase64(bytes)}`;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function imageFormatFromDataUrl(dataUrl: string) {
  if (dataUrl.startsWith("data:image/png")) return "PNG";
  if (dataUrl.startsWith("data:image/webp")) return "WEBP";
  return "JPEG";
}

async function getImageSize(dataUrl: string) {
  if (typeof Image === "undefined") {
    return null;
  }

  return await new Promise<{ width: number; height: number } | null>((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

function containSize(width: number, height: number, maxWidth: number, maxHeight: number) {
  const ratio = Math.min(maxWidth / width, maxHeight / height);
  return {
    width: width * ratio,
    height: height * ratio,
  };
}

function drawWrappedLine(doc: jsPDF, text: string, x: number, y: number, width: number, lineHeight = 3.6) {
  const lines = doc.splitTextToSize(text, width);
  doc.text(lines, x, y);
  return y + Math.max(lineHeight, lines.length * lineHeight);
}

async function drawHeader(doc: jsPDF, invoice: FiscalInvoicePdfInput, logoDataUrl: string | null) {
  const dates = getOfficialInvoiceDates(invoice);
  const companyName = invoice.companyLegalName || "CAR ZONE ACCESORIOS S. DE R.L. DE C.V.";
  const companyRtn = invoice.companyRtn || "-";
  const address = valueOrDash(invoice.companyAddress);

  if (logoDataUrl) {
    const logoMaxWidth = 68;
    const logoMaxHeight = 30;
    let logoSize = await getImageSize(logoDataUrl);
    if (!logoSize) {
      try {
        const properties = doc.getImageProperties(logoDataUrl);
        logoSize = { width: properties.width, height: properties.height };
      } catch {
        logoSize = null;
      }
    }

    if (logoSize) {
      const fittedLogo = containSize(logoSize.width, logoSize.height, logoMaxWidth, logoMaxHeight);
      doc.addImage(logoDataUrl, imageFormatFromDataUrl(logoDataUrl), 17, 18, fittedLogo.width, fittedLogo.height, undefined, "FAST");
    }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(companyName, marginX, 72);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.1);
  let lineY = 77;
  const companyLines = [
    `RTN: ${companyRtn}`,
    `CAI: ${valueOrDash(invoice.cai)}`,
    `Dirección de establecimiento: ${address}`,
    `Rango autorizado: ${valueOrDash(invoice.fiscalRangeStart)} a ${valueOrDash(invoice.fiscalRangeEnd)}`,
    "Vendedor: -",
    `Dirección casa matriz: ${address}`,
    `Teléfono: ${valueOrDash(invoice.companyPhone)} / Correo: ${valueOrDash(invoice.companyEmail)}`,
  ];
  companyLines.forEach((line, index) => {
    doc.setFont("helvetica", index === 0 ? "bold" : "normal");
    lineY = drawWrappedLine(doc, line, marginX, lineY, 122, 3.5);
  });

  doc.setFillColor(...black);
  doc.rect(130, 14, 52, 12, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("FACTURA", 156, 22.2, { align: "center" });

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(8.5);
  doc.setFont("helvetica", "normal");
  doc.text(invoice.invoiceNumber, 130, 31);
  doc.setFont("helvetica", "bold");
  doc.text("Fecha de emisión", 130, 39);
  doc.setFont("helvetica", "normal");
  doc.text(dates.issuedDate, 130, 46);
  doc.setFont("helvetica", "bold");
  doc.text("Fecha de vencimiento", 130, 54);
  doc.setFont("helvetica", "normal");
  doc.text(dates.dueDate, 130, 61);
}

function drawCustomer(doc: jsPDF, invoice: FiscalInvoicePdfInput, startY: number) {
  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  doc.text("Cliente:", 18, startY);
  doc.text(valueOrDash(invoice.customerName), 30, startY);
  doc.line(30, startY + 1.2, 108, startY + 1.2);
  doc.text("RTN:", 112, startY);
  doc.text(valueOrDash(invoice.customerRtn), 124, startY);
  doc.line(124, startY + 1.2, 199, startY + 1.2);
  doc.text("Dirección:", 18, startY + 6);
  doc.text(valueOrDash(invoice.customerAddress), 34, startY + 6);
  doc.line(34, startY + 7.2, 199, startY + 7.2);
}

function drawSummary(doc: jsPDF, invoice: FiscalInvoicePdfInput, startY: number) {
  const totals = getOfficialInvoiceTotals(invoice);
  const rows = summaryRows(totals);
  const observations = [
    invoice.notes ? `Observaciones: ${invoice.notes}` : "Observaciones: -",
    invoice.paymentReference ? `Referencia bancaria: ${invoice.paymentReference}` : null,
    invoice.transferReceiptUrl ? "Comprobante de transferencia: recibido." : null,
    `Total en letras: ${amountToSpanishWords(invoice.total)}`,
  ].filter(Boolean) as string[];

  const leftX = marginX;
  const labelsX = 126;
  const valuesX = 164;
  const summaryLabelTextX = labelsX + 1;
  const boxW = pageWidth - marginX * 2;
  const boxH = Math.max(47, 15 + rows.length * 4);

  doc.setDrawColor(...black);
  doc.rect(leftX, startY, boxW, boxH);
  doc.line(labelsX, startY, labelsX, startY + boxH);
  doc.line(valuesX, startY, valuesX, startY + boxH);

  doc.setFontSize(7.3);
  doc.setFont("helvetica", "normal");
  let obsY = startY + 5;
  observations.forEach((line) => {
    obsY = drawWrappedLine(doc, line, leftX + 2, obsY, labelsX - leftX - 5, 3.5);
  });

  const summaryTextY = startY + 6;
  const summaryRowGap = 4.35;
  const totalSeparatorY = startY + boxH - 7.5;
  const totalTextY = totalSeparatorY + 4.9;

  doc.line(labelsX, totalSeparatorY, pageWidth - marginX, totalSeparatorY);

  rows.forEach((row, index) => {
    const y = row.isTotal ? totalTextY : summaryTextY + index * summaryRowGap;
    doc.setFont("helvetica", row.isTotal ? "bold" : "normal");
    doc.text(row.label, summaryLabelTextX, y);
    doc.text(row.value, pageWidth - marginX - 2, y, { align: "right" });
  });

  const extraY = startY + boxH;
  doc.rect(leftX, extraY, boxW, 18);
  doc.line(labelsX, extraY, labelsX, extraY + 18);
  doc.line(valuesX, extraY, valuesX, extraY + 18);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.2);
  doc.text(`Método de pago: ${paymentLabel(invoice.paymentMethod)}`, leftX + 2, extraY + 4);
  doc.text("Número de orden de compra exenta:", leftX + 2, extraY + 8);
  doc.text("Número constancia de registro de exonerados:", leftX + 2, extraY + 12);
  doc.text("Número de registro de SAG:", leftX + 2, extraY + 16);

  return extraY + 18;
}

function drawFooter(doc: jsPDF, printDate: string) {
  const pageCount = doc.getNumberOfPages();

  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setTextColor(0, 0, 0);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.8);
    doc.text("LA FACTURA ES BENEFICIO DE TODOS, EXÍJALA", pageWidth / 2, pageHeight - 18, { align: "center" });
    doc.setFont("helvetica", "bold");
    doc.text("Original: Cliente - Copia 1: Obligado Tributario Emisor - Copia 2: Archivo", pageWidth / 2, pageHeight - 14, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.text("Documento generado por Car Zone Accesorios", pageWidth / 2, pageHeight - 10, { align: "center" });
    doc.text(`Fecha de impresión: ${printDate}`, pageWidth / 2, pageHeight - 6, { align: "center" });
    doc.text(`Número de página: ${page}/${pageCount}`, pageWidth - marginX, pageHeight - 6, { align: "right" });
  }
}

function drawCancelledWatermark(doc: jsPDF, invoice: FiscalInvoicePdfInput) {
  if (statusLabel(invoice.status) !== "ANULADA") return;

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setTextColor(120, 120, 120);
    doc.setFontSize(34);
    doc.setFont("helvetica", "bold");
    doc.text("FACTURA ANULADA", pageWidth / 2, 150, { align: "center", angle: -20 });
  }

  doc.setTextColor(0, 0, 0);
}

export async function generateFiscalInvoicePdf(invoice: FiscalInvoicePdfInput) {
  const { doc, autoTable } = await createPdfDocument();
  const printDate = formatHnDateTime(new Date().toISOString());
  const logoDataUrl = await imageUrlToDataUrl(getOfficialInvoiceLogoSrc(invoice));

  doc.setFont("helvetica", "normal");
  doc.setTextColor(0, 0, 0);
  await drawHeader(doc, invoice, logoDataUrl);
  drawCustomer(doc, invoice, 126);

  autoTable(doc, {
    startY: 134,
    margin: { left: marginX, right: marginX, bottom: 27 },
    head: [["Cantidad", "Código", "Descripción", "Precio ud.", "Subtotal"]],
    body: invoice.items.map((item) => [
      item.quantity.toLocaleString("es-HN"),
      valueOrDash(item.sku),
      item.name,
      formatCurrency(item.unitPrice),
      formatCurrency(item.lineTotal),
    ]),
    theme: "plain",
    styles: {
      font: "helvetica",
      fontSize: 7.3,
      cellPadding: 1.7,
      overflow: "linebreak",
      lineColor: black,
      lineWidth: 0.15,
      textColor: black,
    },
    headStyles: {
      fillColor: black,
      textColor: [255, 255, 255],
      fontStyle: "bold",
      halign: "center",
      lineColor: black,
      lineWidth: 0.15,
    },
    bodyStyles: {
      lineColor: black,
      lineWidth: 0.15,
    },
    columnStyles: {
      0: { halign: "center", cellWidth: 24 },
      1: { halign: "center", cellWidth: 22 },
      2: { cellWidth: 86 },
      3: { halign: "right", cellWidth: 34 },
      4: { halign: "right", cellWidth: 24 },
    },
    didDrawPage: () => {
      doc.setTextColor(0, 0, 0);
    },
  });

  let finalY = getLastAutoTableY(doc, 143);
  if (finalY > 194) {
    doc.addPage();
    finalY = 18;
  }

  drawSummary(doc, invoice, finalY);
  drawCancelledWatermark(doc, invoice);
  drawFooter(doc, printDate);

  return doc;
}

export async function downloadFiscalInvoicePdf(invoice: FiscalInvoicePdfInput) {
  const doc = await generateFiscalInvoicePdf(invoice);
  doc.save(`${invoice.invoiceNumber}.pdf`);
}

export async function generateFiscalInvoicePdfArrayBuffer(invoice: FiscalInvoicePdfInput) {
  const doc = await generateFiscalInvoicePdf(invoice);
  return doc.output("arraybuffer");
}
