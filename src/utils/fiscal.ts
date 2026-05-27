import type { FiscalAlert, FiscalSettings } from "@/types/fiscal";
import type { InvoiceStatus } from "@/types/invoices";

export type FiscalInvoiceValidation =
  | { ok: true; invoiceNumber: string; nextInvoiceNumber: string }
  | { ok: false; message: string };

const HONDURAS_TIME_ZONE = "America/Tegucigalpa";
const millisecondsPerDay = 24 * 60 * 60 * 1000;

type FiscalInvoiceAlertSource = {
  status: InvoiceStatus | string;
  invoice_number?: string;
  cai?: string | null;
  rtn?: string | null;
  customer_rtn?: string | null;
};

export function invoiceNumberValue(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

export function incrementInvoiceNumber(value: string) {
  const match = value.match(/(\d+)(?!.*\d)/);
  if (!match) {
    return value;
  }

  const current = match[1];
  const next = String(Number(current) + 1).padStart(current.length, "0");
  return `${value.slice(0, match.index)}${next}${value.slice((match.index ?? 0) + current.length)}`;
}

function normalizeFiscalDateKey(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const utcDate = new Date(Date.UTC(year, month - 1, day));

  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day
  ) {
    return null;
  }

  return `${yearText}-${monthText}-${dayText}`;
}

function fiscalDateOrdinal(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / millisecondsPerDay);
}

export function getHondurasDateKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HONDURAS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function daysUntilFiscalDeadline(value: string, now = new Date()) {
  const deadlineKey = normalizeFiscalDateKey(value);
  if (!deadlineKey) {
    return null;
  }

  return fiscalDateOrdinal(deadlineKey) - fiscalDateOrdinal(getHondurasDateKey(now));
}

export function validateFiscalInvoiceSettings(settings: FiscalSettings, now = new Date()): FiscalInvoiceValidation {
  const cai = settings.cai.trim();
  const invoiceNumber = settings.current_invoice_number.trim();
  const rangeStartText = settings.invoice_range_start.trim();
  const rangeEndText = settings.invoice_range_end.trim();
  const current = invoiceNumberValue(invoiceNumber);
  const rangeStart = invoiceNumberValue(rangeStartText);
  const rangeEnd = invoiceNumberValue(rangeEndText);

  if (!cai) {
    return { ok: false, message: "Error fiscal: configura un CAI autorizado antes de generar facturas." };
  }

  if (!invoiceNumber || !rangeStartText || !rangeEndText || current === null || rangeStart === null || rangeEnd === null) {
    return {
      ok: false,
      message: "Error fiscal: configura el número actual y el rango autorizado antes de generar facturas.",
    };
  }

  if (rangeStart > rangeEnd) {
    return { ok: false, message: "Error fiscal: el rango inicial no puede ser mayor que el rango final autorizado." };
  }

  if (current < rangeStart || current > rangeEnd) {
    return { ok: false, message: "Error fiscal: el número actual está fuera del rango autorizado." };
  }

  if (!settings.emission_deadline) {
    return { ok: false, message: "Error fiscal: configura la fecha límite de emisión del CAI." };
  }

  const remainingDays = daysUntilFiscalDeadline(settings.emission_deadline, now);
  if (remainingDays === null || remainingDays < 0) {
    return { ok: false, message: "Error fiscal: la fecha límite de emisión del CAI está vencida." };
  }

  return { ok: true, invoiceNumber, nextInvoiceNumber: incrementInvoiceNumber(invoiceNumber) };
}

export function getFiscalAlerts(
  settings: FiscalSettings,
  invoices: FiscalInvoiceAlertSource[] = [],
  now = new Date(),
): FiscalAlert[] {
  const alerts: FiscalAlert[] = [];
  const cai = settings.cai.trim();
  const rangeStartText = settings.invoice_range_start.trim();
  const rangeEndText = settings.invoice_range_end.trim();
  const invoiceNumber = settings.current_invoice_number.trim();
  const current = invoiceNumberValue(settings.current_invoice_number);
  const rangeStart = invoiceNumberValue(settings.invoice_range_start);
  const rangeEnd = invoiceNumberValue(settings.invoice_range_end);

  if (!cai) {
    alerts.push({
      type: "danger",
      message: "Error fiscal: el CAI no está configurado.",
    });
  }

  if (!invoiceNumber || !rangeStartText || !rangeEndText || current === null || rangeStart === null || rangeEnd === null) {
    alerts.push({
      type: "danger",
      message: "Error fiscal: el correlativo actual o el rango autorizado están incompletos.",
    });
  }

  if (rangeStart !== null && rangeEnd !== null && rangeStart > rangeEnd) {
    alerts.push({
      type: "danger",
      message: "Error fiscal: el rango inicial es mayor que el rango final autorizado.",
    });
  }

  if (current !== null && rangeEnd !== null) {
    if (current > rangeEnd) {
      alerts.push({
        type: "danger",
        message: "No se puede emitir factura fuera del rango autorizado.",
      });
    } else if (rangeEnd - current <= 10) {
      const remaining = Math.max(rangeEnd - current + 1, 0);
      alerts.push({
        type: "warning",
        message: `El rango fiscal está por terminar: quedan ${remaining.toLocaleString("es-HN")} números autorizados.`,
      });
    }
  }

  if (!settings.emission_deadline) {
    alerts.push({
      type: "danger",
      message: "Error fiscal: la fecha límite de emisión del CAI no está configurada.",
    });
  } else {
    const remainingDays = daysUntilFiscalDeadline(settings.emission_deadline, now);
    if (remainingDays === null) {
      alerts.push({
        type: "danger",
        message: "Error fiscal: la fecha límite de emisión no tiene un formato válido.",
      });
    } else if (remainingDays < 0) {
      alerts.push({
        type: "danger",
        message: "La fecha límite de emisión del CAI está vencida. Actualiza el CAI antes de emitir facturas.",
      });
    } else if (remainingDays === 0) {
      alerts.push({
        type: "warning",
        message: "La fecha límite de emisión vence hoy. Este es el último día para emitir facturas con este CAI.",
      });
    } else if (remainingDays === 1) {
      alerts.push({
        type: "warning",
        message: "La fecha límite de emisión está próxima: falta 1 día.",
      });
    } else if (remainingDays <= 15) {
      alerts.push({
        type: "warning",
        message: `La fecha límite de emisión está próxima: faltan ${remainingDays.toLocaleString("es-HN")} días.`,
      });
    }
  }

  const cancelledInvoices = invoices.filter((invoice) => invoice.status === "anulada");
  if (cancelledInvoices.length > 0) {
    alerts.push({
      type: "warning",
      message: `Hay ${cancelledInvoices.length.toLocaleString("es-HN")} facturas anuladas para revisión contable.`,
    });
  }

  const invoicesWithFiscalErrors = invoices.filter((invoice) => !invoice.cai || !invoice.rtn);
  if (invoicesWithFiscalErrors.length > 0) {
    alerts.push({
      type: "danger",
      message: `Hay ${invoicesWithFiscalErrors.length.toLocaleString("es-HN")} facturas con datos fiscales incompletos.`,
    });
  }

  return alerts;
}

