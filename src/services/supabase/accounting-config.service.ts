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

export const accountingMappingDisplayLabels: Record<string, string> = {
  cash: "Caja",
  bank_transfer: "Banco / transferencia",
  card: "Cuenta puente de tarjeta",
  accounts_receivable: "Cuenta por cobrar",
  sales_revenue: "Ingresos por ventas",
  tax_payable: "Impuestos por pagar",
  inventory_asset: "Inventario",
  cost_of_goods_sold: "Costo de ventas",
  inventory_return: "Devolución de inventario",
  inventory_adjustment_gain: "Ajuste positivo de inventario",
  inventory_adjustment_loss: "Ajuste negativo de inventario",
  inventory_writeoff: "Inventario dado de baja",
  accounts_payable: "Proveedores por pagar",
  purchase_inventory: "Inventario para compras",
  purchase_expense: "Gasto de compras",
  supplier_payment_cash: "Pago a proveedores - caja",
  supplier_payment_bank: "Pago a proveedores - banco",
  supplier_payment_card: "Pago a proveedores - tarjeta",
  purchase_tax: "Impuesto de compras",
  purchase_return: "Devoluciones de compras",
  supplier_credit: "Crédito de proveedor",
  suspense: "Cuenta transitoria",
};

export const accountingAutomationModeLabels: Record<AutomationMode, string> = {
  disabled: "Desactivado",
  dry_run: "Simulación",
  draft_only: "Solo borradores",
  auto_post: "Publicación automática",
};

export function getAccountingMappingDisplayLabel(sourceKey: string) {
  const normalizedKey = sourceKey.trim().toLowerCase();
  const label = accountingMappingDisplayLabels[normalizedKey];
  if (label) return label;

  const readable = normalizedKey.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (!readable) return "Mapeo contable";

  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

export function isAccountingMappingType(value: string): value is AccountingMappingType {
  return accountingMappingTypes.includes(value as AccountingMappingType);
}

export function isAccountingAutomationMode(value: string): value is AutomationMode {
  return accountingAutomationModes.includes(value as AutomationMode);
}
