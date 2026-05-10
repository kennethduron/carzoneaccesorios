import type { FiscalAlert, FiscalSettings } from "@/types/fiscal";

function invoiceNumberValue(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

export function getFiscalAlerts(settings: FiscalSettings): FiscalAlert[] {
  const alerts: FiscalAlert[] = [];
  const current = invoiceNumberValue(settings.current_invoice_number);
  const rangeEnd = invoiceNumberValue(settings.invoice_range_end);

  if (current !== null && rangeEnd !== null) {
    if (current > rangeEnd) {
      alerts.push({
        type: "danger",
        message: "No se puede emitir factura fuera del rango autorizado.",
      });
    } else if (rangeEnd - current <= 10) {
      alerts.push({
        type: "warning",
        message: "El rango fiscal está próximo a finalizar.",
      });
    }
  }

  if (settings.emission_deadline) {
    const deadline = new Date(`${settings.emission_deadline}T23:59:59`);
    if (deadline.getTime() < Date.now()) {
      alerts.push({
        type: "danger",
        message: "La fecha límite de emisión está vencida.",
      });
    }
  }

  return alerts;
}
