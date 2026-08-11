import type { AdditionalFee } from "@/types/financial";
import { additionalFeesTotal, roundMoney } from "@/utils/financial-summary";
import { formatHnDate, formatHnDateTime } from "@/utils/format";
import {
  officialInvoiceLogoLayout,
  resolveOfficialInvoiceLogoSrc,
} from "@/utils/official-invoice-logo";
import { paymentMethodLabel } from "@/utils/payment-labels";
import { formatCurrency } from "@/utils/pricing";

export type OfficialInvoiceItem = {
  sku: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  taxCategory?: "standard" | "exempt" | null;
  taxableBase?: number | null;
  taxAmount?: number | null;
  exemptAmount?: number | null;
};

export type OfficialInvoiceInput = {
  invoiceNumber: string;
  orderNumber: string;
  status: string;
  issuedAt: string | null;
  invoiceDate: string | null;
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
  caiAuthorizationDate: string | null;
  fiscalDeadline: string | null;
  customerName: string;
  customerRtn: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  customerCity: string | null;
  customerBusinessName: string | null;
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
  items: OfficialInvoiceItem[];
  notes?: string | null;
};

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

export const officialInvoiceCss = `
  .cz-official-invoice-host {
    box-sizing: border-box;
    width: 100%;
    overflow-x: auto;
    background: #e5e5e5;
    padding: 16px;
  }

  .cz-official-invoice {
    box-sizing: border-box;
    width: 216mm;
    min-height: 279mm;
    margin: 0 auto;
    background: #fff;
    color: #000;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11px;
    line-height: 1.25;
    padding: 12mm 12mm 9mm;
  }

  .cz-official-invoice * {
    box-sizing: border-box;
  }

  .cz-official-invoice p,
  .cz-official-invoice h1,
  .cz-official-invoice h2,
  .cz-official-invoice h3 {
    margin: 0;
  }

  .cz-official-header {
    display: grid;
    grid-template-columns: 1fr 56mm;
    gap: 16mm;
    align-items: start;
  }

  .cz-official-logo-container {
    width: ${officialInvoiceLogoLayout.maxWidthMm}mm;
    max-width: ${officialInvoiceLogoLayout.maxWidthMm}mm;
    height: ${officialInvoiceLogoLayout.maxHeightMm}mm;
    max-height: ${officialInvoiceLogoLayout.maxHeightMm}mm;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    overflow: hidden;
    margin: ${officialInvoiceLogoLayout.htmlMarginTopMm}mm 0 ${officialInvoiceLogoLayout.htmlMarginBottomMm}mm;
  }

  .cz-official-logo {
    display: block;
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    object-position: left center;
  }

  .cz-official-company {
    max-width: 118mm;
  }

  .cz-official-company-name {
    font-size: 14px;
    font-weight: 700;
    margin-bottom: 2px;
  }

  .cz-official-company-lines {
    font-size: 10px;
  }

  .cz-official-invoice-box {
    width: 52mm;
  }

  .cz-official-invoice-title {
    background: #000;
    color: #fff;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1;
    padding: 8px 10px;
    text-align: center;
  }

  .cz-official-invoice-number {
    margin-top: 5px;
    font-size: 12px;
  }

  .cz-official-date-label {
    margin-top: 11px;
    font-size: 12px;
    font-weight: 700;
  }

  .cz-official-date-value {
    margin-top: 7px;
    font-size: 12px;
  }

  .cz-official-client {
    margin-top: 10px;
    font-size: 11px;
  }

  .cz-official-client-row {
    display: grid;
    grid-template-columns: 38mm minmax(0, 1fr) 11mm 52mm;
    gap: 4px;
    align-items: end;
  }

  .cz-official-client-row + .cz-official-client-row {
    margin-top: 2px;
    grid-template-columns: 18mm 1fr;
  }

  .cz-official-line-value {
    min-height: 15px;
    border-bottom: 2px solid #222;
    padding: 0 6px 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cz-official-items {
    width: 100%;
    margin-top: 9px;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 10px;
  }

  .cz-official-items th {
    background: #000;
    color: #fff;
    border: 1px solid #000;
    padding: 4px 5px;
    text-align: center;
    font-weight: 700;
  }

  .cz-official-items td {
    border-left: 1px solid #000;
    border-right: 1px solid #000;
    padding: 5px 6px;
    vertical-align: top;
  }

  .cz-official-items tbody tr:first-child td {
    border-top: 1px solid #000;
  }

  .cz-official-items tbody tr:last-child td {
    border-bottom: 1px solid #000;
  }

  .cz-official-qty {
    width: 22mm;
    text-align: center;
  }

  .cz-official-code {
    width: 22mm;
    text-align: center;
  }

  .cz-official-price,
  .cz-official-subtotal {
    width: 34mm;
    text-align: right;
    white-space: nowrap;
  }

  .cz-official-description {
    overflow-wrap: anywhere;
  }

  .cz-official-summary-grid {
    display: grid;
    grid-template-columns: 1fr 54mm 34mm;
    border: 1px solid #000;
    border-top: 0;
    min-height: 44mm;
    font-size: 10px;
  }

  .cz-official-observations {
    border-right: 1px solid #000;
    padding: 5px 7px;
  }

  .cz-official-totals-labels,
  .cz-official-totals-values {
    padding: 5px 7px;
  }

  .cz-official-totals-values {
    border-left: 1px solid #000;
    text-align: right;
  }

  .cz-official-total-row {
    min-height: 18px;
    margin-bottom: 3px;
  }

  .cz-official-total-final {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid #000;
    font-weight: 700;
  }

  .cz-official-fiscal-extra {
    display: grid;
    grid-template-columns: 1fr 54mm 34mm;
    border: 1px solid #000;
    border-top: 0;
    font-size: 10px;
  }

  .cz-official-extra-left {
    min-height: 18mm;
    border-right: 1px solid #000;
    padding: 4px 7px;
  }

  .cz-official-extra-spacer {
    border-right: 1px solid #000;
  }

  .cz-official-footer {
    margin-top: 5mm;
    text-align: center;
    font-size: 8.5px;
    line-height: 1.35;
  }

  .cz-official-footer strong {
    font-weight: 700;
  }

  .cz-official-watermark {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
    color: rgba(0, 0, 0, 0.12);
    font-size: 54px;
    font-weight: 700;
    transform: rotate(-18deg);
  }

  .cz-official-page-wrap {
    position: relative;
  }

  @media screen and (max-width: 820px) {
    .cz-official-invoice-host {
      overflow-x: hidden;
      padding: 8px;
    }

    .cz-official-invoice {
      width: 100%;
      min-height: auto;
      padding: 14px;
      font-size: 10px;
    }

    .cz-official-header {
      grid-template-columns: minmax(0, 1fr);
      gap: 12px;
    }

    .cz-official-logo-container {
      width: 100%;
      max-width: 100%;
      height: ${officialInvoiceLogoLayout.mobileMaxHeightPx}px;
      max-height: ${officialInvoiceLogoLayout.mobileMaxHeightPx}px;
      margin: 0 0 12px;
    }

    .cz-official-company {
      max-width: none;
    }

    .cz-official-company-name {
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .cz-official-company-lines {
      font-size: 9px;
      overflow-wrap: anywhere;
    }

    .cz-official-invoice-box {
      width: 100%;
    }

    .cz-official-invoice-title {
      font-size: 18px;
      padding: 7px 8px;
    }

    .cz-official-client-row,
    .cz-official-client-row + .cz-official-client-row {
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
      align-items: start;
    }

    .cz-official-line-value {
      white-space: normal;
      overflow: visible;
      text-overflow: clip;
      overflow-wrap: anywhere;
    }

    .cz-official-items,
    .cz-official-items thead,
    .cz-official-items tbody,
    .cz-official-items tr,
    .cz-official-items th,
    .cz-official-items td {
      display: block;
      width: 100%;
    }

    .cz-official-items thead {
      display: none;
    }

    .cz-official-items tr {
      border: 1px solid #000;
      margin-top: 8px;
    }

    .cz-official-items td {
      border: 0;
      border-bottom: 1px solid #ddd;
      text-align: left;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .cz-official-items td:last-child {
      border-bottom: 0;
    }

    .cz-official-qty::before {
      content: "Cantidad: ";
      font-weight: 700;
    }

    .cz-official-code::before {
      content: "Código: ";
      font-weight: 700;
    }

    .cz-official-description::before {
      content: "Descripción: ";
      font-weight: 700;
    }

    .cz-official-price::before {
      content: "Precio ud.: ";
      font-weight: 700;
    }

    .cz-official-subtotal::before {
      content: "Subtotal: ";
      font-weight: 700;
    }

    .cz-official-summary-grid,
    .cz-official-fiscal-extra {
      grid-template-columns: minmax(0, 1fr);
    }

    .cz-official-observations,
    .cz-official-totals-values,
    .cz-official-extra-left,
    .cz-official-extra-spacer {
      border-right: 0;
      border-bottom: 1px solid #000;
    }

    .cz-official-totals-labels {
      display: none;
    }

    .cz-official-totals-values {
      text-align: left;
    }

    .cz-official-totals-values .cz-official-total-row::before {
      content: attr(data-label) ": ";
      font-weight: 700;
    }
  }

  @media print {
    @page {
      size: letter;
      margin: 0;
    }

    html,
    body {
      margin: 0;
      background: #fff;
    }

    .cz-official-invoice-host {
      padding: 0;
      background: #fff;
      overflow: visible;
    }

    .cz-official-invoice {
      width: 216mm;
      min-height: 279mm;
      margin: 0;
      padding: 12mm 12mm 9mm;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }

    .cz-official-items thead {
      display: table-header-group;
    }

    .cz-official-items tr,
    .cz-official-summary-grid,
    .cz-official-fiscal-extra,
    .cz-official-footer {
      break-inside: avoid;
    }
  }
`;

function amountChunkToWords(value: number): string {
  if (value === 0) return "";
  if (value === 100) return "cien";
  if (value < 20) return units[value];
  if (value < 30) return value === 20 ? "veinte" : `veinti${units[value - 20]}`;
  if (value < 100) {
    const ten = Math.floor(value / 10);
    const unit = value % 10;
    return unit ? `${tens[ten]} y ${units[unit]}` : tens[ten];
  }

  const hundred = Math.floor(value / 100);
  const remainder = value % 100;
  return `${hundreds[hundred]} ${amountChunkToWords(remainder)}`.trim();
}

export function amountToSpanishWords(amount: number) {
  const fixedAmount = Math.max(0, roundMoney(amount));
  const integer = Math.floor(fixedAmount);
  const cents = Math.round((fixedAmount - integer) * 100);

  if (integer === 0) {
    return `CERO LEMPIRAS CON ${String(cents).padStart(2, "0")}/100`;
  }

  const millions = Math.floor(integer / 1_000_000);
  const thousands = Math.floor((integer % 1_000_000) / 1000);
  const remainder = integer % 1000;
  const parts: string[] = [];

  if (millions) parts.push(millions === 1 ? "un millon" : `${amountChunkToWords(millions)} millones`);
  if (thousands) parts.push(thousands === 1 ? "mil" : `${amountChunkToWords(thousands)} mil`);
  if (remainder) parts.push(amountChunkToWords(remainder));

  return `${parts.join(" ").toUpperCase()} LEMPIRAS CON ${String(cents).padStart(2, "0")}/100`;
}

export function valueOrDash(value: string | null | undefined) {
  return value && value.trim() ? value.trim() : "-";
}

function cleanDocumentLocationPart(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, " ") || "";
}

export function formatDocumentCustomerAddress(
  city: string | null | undefined,
  address: string | null | undefined,
) {
  const cleanCity = cleanDocumentLocationPart(city);
  const cleanAddress = cleanDocumentLocationPart(address);
  if (!cleanCity) return cleanAddress || "-";
  if (!cleanAddress) return cleanCity;

  const normalizedCity = cleanCity.toLocaleLowerCase("es-HN");
  const normalizedAddress = cleanAddress.toLocaleLowerCase("es-HN");
  const addressSegments = normalizedAddress.split(/\s*[,;|]\s*/).filter(Boolean);
  if (normalizedAddress === normalizedCity || addressSegments.includes(normalizedCity)) {
    return cleanAddress;
  }

  return `${cleanCity}, ${cleanAddress}`;
}

export function paymentLabel(method: string) {
  if (method === "bank_transfer" || method === "Transferencia bancaria") return "Transferencia bancaria";
  if (method === "card" || method === "Tarjeta") return "Tarjeta mediante enlace de pago";
  if (method === "cash" || method === "Efectivo") return "Efectivo";
  if (method === "commercial_credit" || method === "Crédito Comercial" || method === "Crédito comercial") return "Crédito comercial";
  return paymentMethodLabel(method, { detailedCard: true });
}

export function statusLabel(status: string) {
  if (status === "anulada" || status === "cancelled") return "ANULADA";
  if (status === "pendiente" || status === "draft") return "PENDIENTE";
  return "EMITIDA";
}

export function getOfficialInvoiceLogoSrc(invoice: OfficialInvoiceInput) {
  return resolveOfficialInvoiceLogoSrc(invoice.companyLogoUrl);
}

function formatOfficialDate(value: string | null | undefined) {
  if (!value) return "-";

  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  }

  const formatted = formatHnDate(value);
  const parts = formatted.split("/");
  return parts.length === 3 ? `${parts[0].padStart(2, "0")}/${parts[1].padStart(2, "0")}/${parts[2]}` : formatted;
}

export function getOfficialInvoiceDates(invoice: OfficialInvoiceInput) {
  return {
    issuedDate: formatOfficialDate(invoice.invoiceDate ?? invoice.issuedAt ?? invoice.createdAt),
    dueDate: formatOfficialDate(invoice.dueAt ?? invoice.fiscalDeadline),
    caiAuthorizationDate: formatOfficialDate(invoice.caiAuthorizationDate),
    fiscalDeadline: formatOfficialDate(invoice.fiscalDeadline ?? invoice.dueAt),
  };
}

export function getOfficialInvoiceTotals(invoice: OfficialInvoiceInput) {
  const additionalFees = (invoice.additionalFees ?? []).filter((fee) => Number(fee.amount) > 0);
  const posFeeLabels = new Set(['cargo adicional', 'otro cargo']);
  const itemizedAdditionalFees = additionalFees.filter((fee) => fee.category === 'additional_charge'
    || fee.category === 'other_charge'
    || posFeeLabels.has(fee.label.trim().toLowerCase()));
  const otherFees = additionalFeesTotal(additionalFees.filter((fee) => fee.category !== 'additional_charge'
    && fee.category !== 'other_charge'
    && !posFeeLabels.has(fee.label.trim().toLowerCase())));
  const discountTotal = roundMoney(invoice.discountTotal ?? 0);
  const shippingFee = roundMoney(invoice.shippingFee ?? 0);
  const cashOnDeliveryFee = roundMoney(invoice.cashOnDeliveryFee ?? 0);
  const smallOrderFee = roundMoney(invoice.smallOrderFee ?? 0);
  // subtotal is already the persisted taxable base after discounts. Reapplying
  // discountTotal here would make the PDF diverge from the order and invoice.
  const hasLineTaxSnapshots = invoice.items.length > 0
    && invoice.items.every((item) => item.taxCategory === "standard" || item.taxCategory === "exempt");
  const taxableBase = hasLineTaxSnapshots
    ? roundMoney(invoice.items.reduce((sum, item) => sum + (item.taxableBase ?? 0), 0))
    : roundMoney(Math.max(0, invoice.subtotal));
  const exemptBase = hasLineTaxSnapshots
    ? roundMoney(invoice.items.reduce((sum, item) => sum + (item.exemptAmount ?? 0), 0))
    : invoice.tax > 0 ? 0 : taxableBase;
  const tax15 = hasLineTaxSnapshots
    ? roundMoney(invoice.items.reduce((sum, item) => sum + (item.taxAmount ?? 0), 0))
    : invoice.tax;

  return {
    subtotal: invoice.subtotal,
    exonerated: 0,
    exempt: exemptBase,
    taxable15: hasLineTaxSnapshots ? taxableBase : invoice.tax > 0 ? taxableBase : 0,
    taxable18: 0,
    tax15,
    tax18: 0,
    discountTotal,
    total: invoice.total,
    otherFees,
    shippingFee,
    cashOnDeliveryFee,
    smallOrderFee,
    itemizedAdditionalFees,
  };
}

export function buildOfficialInvoiceHtml(invoice: OfficialInvoiceInput, options: { printedAt?: string } = {}) {
  const dates = getOfficialInvoiceDates(invoice);
  const totals = getOfficialInvoiceTotals(invoice);
  const printedAt = options.printedAt ?? formatHnDateTime(new Date().toISOString());
  const logoSrc = getOfficialInvoiceLogoSrc(invoice);
  const companyName = invoice.companyLegalName || "CAR ZONE ACCESORIOS S. DE R.L. DE C.V.";
  const companyRtn = invoice.companyRtn || "-";
  const address = valueOrDash(invoice.companyAddress);
  const observations = [
    invoice.notes ? `Observaciones: ${invoice.notes}` : "Observaciones: -",
    invoice.paymentReference ? `Referencia bancaria: ${invoice.paymentReference}` : null,
    invoice.transferReceiptUrl ? "Comprobante de transferencia: recibido." : null,
    `Total en letras: ${amountToSpanishWords(invoice.total)}`,
  ].filter(Boolean);
  const summary = summaryRows(totals);

  return `
    <div class="cz-official-page-wrap">
      ${statusLabel(invoice.status) === "ANULADA" ? `<div class="cz-official-watermark">FACTURA ANULADA</div>` : ""}
      <article class="cz-official-invoice" aria-label="Factura ${escapeHtml(invoice.invoiceNumber)}">
        <header class="cz-official-header">
          <div>
            ${
              logoSrc
                ? `<div class="cz-official-logo-container"><img class="cz-official-logo" src="${escapeHtml(logoSrc)}" alt="Car Zone Accesorios" /></div>`
                : ""
            }
            <section class="cz-official-company">
              <h1 class="cz-official-company-name">${escapeHtml(companyName)}</h1>
              <div class="cz-official-company-lines">
                <p><strong>RTN: ${escapeHtml(companyRtn)}</strong></p>
                <p>CAI: ${escapeHtml(valueOrDash(invoice.cai))}</p>
                <p>Dirección de establecimiento: ${escapeHtml(address)}</p>
                <p>Rango autorizado: ${escapeHtml(valueOrDash(invoice.fiscalRangeStart))} a ${escapeHtml(valueOrDash(invoice.fiscalRangeEnd))}</p>
                <p>Vendedor: -</p>
                <p>Dirección casa matriz: ${escapeHtml(address)}</p>
                <p>Teléfono: ${escapeHtml(valueOrDash(invoice.companyPhone))} / Correo: ${escapeHtml(valueOrDash(invoice.companyEmail))}</p>
              </div>
            </section>
          </div>
          <aside class="cz-official-invoice-box">
            <div class="cz-official-invoice-title">FACTURA</div>
            <p class="cz-official-invoice-number">${escapeHtml(invoice.invoiceNumber)}</p>
            <p class="cz-official-date-label">Fecha de emisión</p>
            <p class="cz-official-date-value">${escapeHtml(dates.issuedDate)}</p>
            <p class="cz-official-date-label">Fecha de autorización del CAI</p>
            <p class="cz-official-date-value">${escapeHtml(dates.caiAuthorizationDate)}</p>
            <p class="cz-official-date-label">Fecha límite de emisión</p>
            <p class="cz-official-date-value">${escapeHtml(dates.fiscalDeadline)}</p>
          </aside>
        </header>

        <section class="cz-official-client">
          <div class="cz-official-client-row">
            <span>Nombre / Razón Social:</span>
            <span class="cz-official-line-value">${escapeHtml(invoice.customerName)}</span>
            <span>RTN:</span>
            <span class="cz-official-line-value">${escapeHtml(valueOrDash(invoice.customerRtn))}</span>
          </div>
          <div class="cz-official-client-row">
            <span>Empresa:</span>
            <span class="cz-official-line-value">${escapeHtml(valueOrDash(invoice.customerBusinessName))}</span>
          </div>
          <div class="cz-official-client-row">
            <span>Dirección:</span>
            <span class="cz-official-line-value">${escapeHtml(formatDocumentCustomerAddress(invoice.customerCity, invoice.customerAddress))}</span>
          </div>
        </section>

        <table class="cz-official-items">
          <thead>
            <tr>
              <th class="cz-official-qty">Cantidad</th>
              <th class="cz-official-code">Código</th>
              <th>Descripción</th>
              <th class="cz-official-price">Precio ud.</th>
              <th class="cz-official-subtotal">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${invoice.items.map((item) => `
              <tr>
                <td class="cz-official-qty">${escapeHtml(item.quantity.toLocaleString("es-HN"))}</td>
                <td class="cz-official-code">${escapeHtml(valueOrDash(item.sku))}</td>
                <td class="cz-official-description">${escapeHtml(item.name)}</td>
                <td class="cz-official-price">${escapeHtml(formatCurrency(item.unitPrice))}</td>
                <td class="cz-official-subtotal">${escapeHtml(formatCurrency(item.lineTotal))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>

        <section class="cz-official-summary-grid">
          <div class="cz-official-observations">
            ${observations.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
          </div>
          <div class="cz-official-totals-labels">
            ${summary.map((row) => `<p class="cz-official-total-row ${row.isTotal ? "cz-official-total-final" : ""}">${escapeHtml(row.label)}</p>`).join("")}
          </div>
          <div class="cz-official-totals-values">
            ${summary.map((row) => `<p data-label="${escapeHtml(row.label)}" class="cz-official-total-row ${row.isTotal ? "cz-official-total-final" : ""}">${escapeHtml(row.value)}</p>`).join("")}
          </div>
        </section>

        <section class="cz-official-fiscal-extra">
          <div class="cz-official-extra-left">
            <p>Método de pago: ${escapeHtml(paymentLabel(invoice.paymentMethod))}</p>
            <p>Número de orden de compra exenta:</p>
            <p>Número constancia de registro de exonerados:</p>
            <p>Número de registro de SAG:</p>
          </div>
          <div class="cz-official-extra-spacer"></div>
          <div></div>
        </section>

        <footer class="cz-official-footer">
          <p>LA FACTURA ES BENEFICIO DE TODOS, EXÍJALA</p>
          <p><strong>Original: Cliente - Copia 1: Obligado Tributario Emisor - Copia 2: Archivo</strong></p>
          <p>Documento generado por Car Zone Accesorios</p>
          <p>Fecha de impresión: ${escapeHtml(printedAt)}</p>
          <p>Número de página: <span class="cz-page-number">1/1</span></p>
        </footer>
      </article>
    </div>
  `;
}

export function buildOfficialInvoicePrintHtml(invoice: OfficialInvoiceInput, options: { baseUrl?: string } = {}) {
  const printedAt = formatHnDateTime(new Date().toISOString());
  return `<!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        ${options.baseUrl ? `<base href="${escapeHtml(options.baseUrl)}" />` : ""}
        <title>Factura ${escapeHtml(invoice.invoiceNumber)}</title>
        <style>${officialInvoiceCss}</style>
      </head>
      <body>
        <main class="cz-official-invoice-host">
          ${buildOfficialInvoiceHtml(invoice, { printedAt })}
        </main>
      </body>
    </html>`;
}

export function summaryRows(totals: ReturnType<typeof getOfficialInvoiceTotals>) {
  const rows = [
    { label: "Subtotal antes de ISV", value: formatCurrency(totals.subtotal) },
    { label: "Importe exonerado", value: formatCurrency(totals.exonerated) },
    { label: "Importe exento", value: formatCurrency(totals.exempt) },
    { label: "Importe gravado 15% ISV", value: formatCurrency(totals.taxable15) },
    { label: "Importe gravado 18% ISV", value: formatCurrency(totals.taxable18) },
    { label: "Total 15% ISV", value: formatCurrency(totals.tax15) },
    { label: "Total 18% ISV", value: formatCurrency(totals.tax18) },
    totals.shippingFee > 0 ? { label: "Envío estándar", value: formatCurrency(totals.shippingFee) } : null,
    totals.cashOnDeliveryFee > 0 ? { label: "Contra entrega", value: formatCurrency(totals.cashOnDeliveryFee) } : null,
    totals.smallOrderFee > 0 ? { label: "Recargo pedido mínimo", value: formatCurrency(totals.smallOrderFee) } : null,
    ...totals.itemizedAdditionalFees.map((fee) => ({ label: fee.label, value: formatCurrency(fee.amount) })),
    totals.otherFees > 0 ? { label: "Otros cargos", value: formatCurrency(totals.otherFees) } : null,
    totals.discountTotal > 0 ? { label: "Descuento", value: formatCurrency(totals.discountTotal) } : null,
    { label: "Total", value: formatCurrency(totals.total), isTotal: true },
  ];

  return rows.filter(Boolean) as Array<{ label: string; value: string; isTotal?: boolean }>;
}

export function summaryLabels(totals: ReturnType<typeof getOfficialInvoiceTotals>) {
  return summaryRows(totals).map((row) => row.label);
}

export function summaryValues(totals: ReturnType<typeof getOfficialInvoiceTotals>) {
  return summaryRows(totals).map((row) => row.value);
}

export function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
