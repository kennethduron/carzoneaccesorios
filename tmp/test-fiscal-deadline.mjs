import assert from "node:assert/strict";
import {
  daysUntilFiscalDeadline,
  getFiscalAlerts,
  getHondurasDateKey,
  validateFiscalInvoiceSettings,
} from "../src/utils/fiscal.ts";

function fiscalSettings(emissionDeadline) {
  return {
    legal_name: "Car Zone Accesorios",
    rtn: "08011999123456",
    cai: "CAI-TEST",
    invoice_range_start: "000-001-01-00000001",
    invoice_range_end: "000-001-01-00000100",
    current_invoice_number: "000-001-01-00000010",
    emission_deadline: emissionDeadline,
    fiscal_address: "Tegucigalpa",
    phone: "0000-0000",
    email: "admin@example.com",
    logo_url: null,
  };
}

function assertAllowed(now, deadline) {
  assert.equal(validateFiscalInvoiceSettings(fiscalSettings(deadline), now).ok, true);
}

function assertBlocked(now, deadline) {
  const result = validateFiscalInvoiceSettings(fiscalSettings(deadline), now);
  assert.equal(result.ok, false);
  assert.equal(result.message, "Error fiscal: la fecha límite de emisión del CAI está vencida.");
}

const may25Honduras = new Date("2026-05-25T18:00:00.000Z");
const may26Honduras = new Date("2026-05-26T18:00:00.000Z");
const may27Honduras = new Date("2026-05-27T18:00:00.000Z");
const utcMay27StillMay26Honduras = new Date("2026-05-27T03:00:00.000Z");

assert.equal(getHondurasDateKey(utcMay27StillMay26Honduras), "2026-05-26");

assertAllowed(may26Honduras, "2026-05-26");
assert.equal(daysUntilFiscalDeadline("2026-05-26", may26Honduras), 0);

assertBlocked(may27Honduras, "2026-05-26");
assert.equal(daysUntilFiscalDeadline("2026-05-26", may27Honduras), -1);

assertAllowed(may25Honduras, "2026-05-26");
assert.equal(daysUntilFiscalDeadline("2026-05-26", may25Honduras), 1);
assert.equal(
  getFiscalAlerts(fiscalSettings("2026-05-26"), [], may25Honduras).at(-1)?.message,
  "La fecha límite de emisión está próxima: falta 1 día.",
);

assertAllowed(may26Honduras, "2026-05-27");
assert.equal(
  getFiscalAlerts(fiscalSettings("2026-05-27"), [], may26Honduras).at(-1)?.message,
  "La fecha límite de emisión está próxima: falta 1 día.",
);

assertAllowed(utcMay27StillMay26Honduras, "2026-05-26");
assert.equal(
  getFiscalAlerts(fiscalSettings("2026-05-26"), [], utcMay27StillMay26Honduras).at(-1)?.message,
  "La fecha límite de emisión vence hoy. Este es el último día para emitir facturas con este CAI.",
);

assert.equal(
  getFiscalAlerts(fiscalSettings("2026-05-26"), [], may27Honduras).at(-1)?.message,
  "La fecha límite de emisión del CAI está vencida. Actualiza el CAI antes de emitir facturas.",
);

console.log("Fiscal CAI deadline date tests passed.");
