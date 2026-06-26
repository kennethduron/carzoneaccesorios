import type { AccountingMappingType, AutomationMode } from "@/types/financial-center";

export const accountingMappingTypes: AccountingMappingType[] = [
  "default_account",
  "payment_method",
  "revenue",
  "tax",
  "receivable",
  "inventory",
  "discount",
  "shipping",
  "rounding",
  "suspense",
];

export const accountingAutomationModes: AutomationMode[] = ["disabled", "dry_run", "draft_only", "auto_post"];
export const phase2AAutomationModes: AutomationMode[] = ["disabled", "dry_run", "draft_only"];

export const accountingMappingTypeLabels: Record<AccountingMappingType, string> = {
  default_account: "Cuenta predeterminada",
  payment_method: "Método de pago",
  revenue: "Ingresos",
  tax: "Impuestos",
  receivable: "Cuenta por cobrar",
  inventory: "Inventario",
  discount: "Descuentos",
  shipping: "Envíos",
  rounding: "Redondeo",
  suspense: "Cuenta transitoria",
};

export const accountingAutomationModeLabels: Record<AutomationMode, string> = {
  disabled: "Desactivado",
  dry_run: "Simulación",
  draft_only: "Solo borradores",
  auto_post: "Publicación automática",
};

export function isAccountingMappingType(value: string): value is AccountingMappingType {
  return accountingMappingTypes.includes(value as AccountingMappingType);
}

export function isAccountingAutomationMode(value: string): value is AutomationMode {
  return accountingAutomationModes.includes(value as AutomationMode);
}
