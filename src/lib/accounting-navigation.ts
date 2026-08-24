export const financialCenterTabs = ["summary", "mappings", "events", "journal", "accounts"] as const;

export type FinancialCenterTab = (typeof financialCenterTabs)[number];

const financialCenterTabSet = new Set<string>(financialCenterTabs);

export function normalizeFinancialCenterTab(value: unknown): FinancialCenterTab {
  return typeof value === "string" && financialCenterTabSet.has(value)
    ? (value as FinancialCenterTab)
    : "summary";
}

export function buildJournalEntryViewerHref(journalEntryId: string) {
  const search = new URLSearchParams();
  search.set("tab", "journal");
  search.set("partida", journalEntryId);
  return `/admin/contabilidad?${search.toString()}`;
}

const journalSourceLabels: Record<string, string> = {
  manual: "Partida manual",
  financial_event: "Evento financiero",
  order: "Venta",
  payment: "Pago recibido",
  invoice: "Factura",
  commercial_credit: "Crédito comercial",
  accounts_receivable: "Cuenta por cobrar",
  receivable_payment: "Abono recibido",
  inventory_movement: "Inventario",
  purchase: "Compra",
  supplier_invoice: "Factura de proveedor",
  accounts_payable: "Cuenta por pagar",
  supplier_payment: "Pago a proveedor",
  purchase_return: "Devolución a proveedor",
  supplier_credit: "Crédito de proveedor",
};

export function journalSourceLabel(sourceType: string | null) {
  if (!sourceType) return "Partida manual";
  return journalSourceLabels[sourceType] ?? "Origen contable";
}

export function journalEntryStatusLabel(status: "borrador" | "publicada" | "reversada" | "anulada") {
  return {
    borrador: "Borrador",
    publicada: "Publicada",
    reversada: "Reversada",
    anulada: "Anulada",
  }[status];
}

export function buildJournalEntryPrintHref(journalEntryId: string) {
  return `/admin/contabilidad/partidas/${encodeURIComponent(journalEntryId)}/imprimir`;
}
