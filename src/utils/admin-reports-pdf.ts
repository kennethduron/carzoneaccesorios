import type jsPDF from "jspdf";
import type { UserOptions } from "jspdf-autotable";
import { formatHnDate, formatHnDateTime } from "@/utils/format";
import { resolveOfficialInvoiceLogoSrc } from "@/utils/official-invoice-logo";

const businessName = "Car Zone Accesorios";
const marginX = 14;
const headerTop = 8;
const tableTop = 38;
const footerMargin = 18;

export type AdminReportPdfInput = {
  reportKey: string;
  reportLabel: string;
  columns: string[];
  rows: string[][];
  startDate: string;
  endDate: string;
  logoUrl: string | null | undefined;
  generatedAt?: string;
};

export type AdminReportPdfResult = {
  doc: jsPDF;
  metadata: {
    pageCount: number;
    rowCount: number;
    generatedAt: string;
    logoSource: string;
    orientation: "landscape" | "portrait";
  };
};

export class ReportsPdfBrandingError extends Error {
  constructor(message = "No se pudo cargar el logo oficial de Car Zone Accesorios. El PDF no fue descargado.") {
    super(message);
    this.name = "ReportsPdfBrandingError";
  }
}

function bytesToBase64(bytes: Uint8Array) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function loadOfficialLogoDataUrl(logoUrl: string | null | undefined) {
  const logoSource = resolveOfficialInvoiceLogoSrc(logoUrl);
  try {
    const response = await fetch(logoSource, { cache: "force-cache" });
    if (!response.ok) throw new ReportsPdfBrandingError();
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!contentType || !["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(contentType)) {
      throw new ReportsPdfBrandingError();
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new ReportsPdfBrandingError();
    return { logoSource, dataUrl: `data:${contentType};base64,${bytesToBase64(bytes)}` };
  } catch (error) {
    if (error instanceof ReportsPdfBrandingError) throw error;
    throw new ReportsPdfBrandingError();
  }
}

function imageFormat(dataUrl: string) {
  if (dataUrl.startsWith("data:image/png")) return "PNG";
  if (dataUrl.startsWith("data:image/webp")) return "WEBP";
  return "JPEG";
}

function reportTitle(input: AdminReportPdfInput) {
  return input.reportKey === "creditReceivablePayments" ? "Reporte de abonos de cuentas por cobrar" : input.reportLabel;
}

function displayRange(startDate: string, endDate: string) {
  return `${startDate ? formatHnDate(startDate) : "inicio"} a ${endDate ? formatHnDate(endDate) : "hoy"}`;
}

function creditReceivableColumnStyles(): UserOptions["columnStyles"] {
  return {
    0: { cellWidth: 34 },
    1: { cellWidth: 22 },
    2: { cellWidth: 21, halign: "right" },
    3: { cellWidth: 21, halign: "right" },
    4: { cellWidth: 21, halign: "right" },
    5: { cellWidth: 20 },
    6: { cellWidth: 21 },
    7: { cellWidth: 24 },
    8: { cellWidth: 23 },
    9: { cellWidth: 21 },
    10: { cellWidth: 21, halign: "right" },
  };
}

function drawHeader(doc: jsPDF, input: AdminReportPdfInput, logoDataUrl: string) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const logoMaxWidth = 43;
  const logoMaxHeight = 17;
  let properties: ReturnType<jsPDF["getImageProperties"]>;
  try {
    properties = doc.getImageProperties(logoDataUrl);
  } catch {
    throw new ReportsPdfBrandingError();
  }
  const ratio = Math.min(logoMaxWidth / properties.width, logoMaxHeight / properties.height);
  try {
    doc.addImage(
      logoDataUrl,
      imageFormat(logoDataUrl),
      marginX,
      headerTop,
      properties.width * ratio,
      properties.height * ratio,
      "car-zone-official-report-logo",
      "FAST",
    );
  } catch {
    throw new ReportsPdfBrandingError();
  }

  const textX = marginX + logoMaxWidth + 7;
  doc.setTextColor(8, 8, 8);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(businessName, textX, 12);
  doc.setFontSize(13);
  doc.text(reportTitle(input), textX, 18);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.text(`Rango: ${displayRange(input.startDate, input.endDate)}`, textX, 23.5);
  doc.text(`Generado: ${formatHnDateTime(input.generatedAt ?? new Date().toISOString())} (Honduras)`, textX, 28);
  doc.setDrawColor(210, 210, 210);
  doc.line(marginX, 33, pageWidth - marginX, 33);
}

function drawFooters(doc: jsPDF, generatedAt: string) {
  const pageCount = doc.getNumberOfPages();
  const generated = formatHnDateTime(generatedAt);
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    doc.setDrawColor(210, 210, 210);
    doc.line(marginX, pageHeight - 14, pageWidth - marginX, pageHeight - 14);
    doc.setTextColor(70, 70, 70);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.text(`${businessName} - Documento generado desde el sistema administrativo.`, marginX, pageHeight - 8);
    doc.text(`Generado: ${generated}`, pageWidth / 2, pageHeight - 8, { align: "center" });
    doc.setFont("helvetica", "bold");
    doc.text(`Página ${page} de ${pageCount}`, pageWidth - marginX, pageHeight - 8, { align: "right" });
  }
}

export async function generateAdminReportPdf(input: AdminReportPdfInput): Promise<AdminReportPdfResult> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const orientation = input.columns.length > 5 ? "landscape" : "portrait";
  const [{ jsPDF }, { default: autoTable }, logo] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
    loadOfficialLogoDataUrl(input.logoUrl),
  ]);
  const doc = new jsPDF({ orientation, unit: "mm", format: "a4" });
  drawHeader(doc, { ...input, generatedAt }, logo.dataUrl);
  autoTable(doc, {
    startY: tableTop,
    margin: { top: tableTop, right: marginX, bottom: footerMargin, left: marginX },
    tableWidth: input.reportKey === "creditReceivablePayments" ? 249 : "auto",
    head: [input.columns],
    body: input.rows,
    theme: "grid",
    showHead: "everyPage",
    styles: {
      font: "helvetica",
      fontSize: input.columns.length > 8 ? 6.4 : 8,
      cellPadding: 1.5,
      cellWidth: "auto",
      overflow: "linebreak",
      valign: "middle",
      lineColor: [220, 220, 220],
      lineWidth: 0.1,
      textColor: [25, 25, 25],
    },
    headStyles: {
      fillColor: [36, 106, 115],
      textColor: [255, 255, 255],
      fontStyle: "bold",
      halign: "center",
      lineColor: [36, 106, 115],
    },
    alternateRowStyles: { fillColor: [247, 249, 249] },
    columnStyles: input.reportKey === "creditReceivablePayments" ? creditReceivableColumnStyles() : undefined,
    didDrawPage: ({ pageNumber }) => {
      if (pageNumber > 1) drawHeader(doc, { ...input, generatedAt }, logo.dataUrl);
    },
  });
  drawFooters(doc, generatedAt);
  return {
    doc,
    metadata: {
      pageCount: doc.getNumberOfPages(),
      rowCount: input.rows.length,
      generatedAt,
      logoSource: logo.logoSource,
      orientation,
    },
  };
}
