export type PurchasePayableLine = {
  account_id: string;
  debit: number;
  credit: number;
  description: string;
};

export type PurchasePayableLineError =
  | "invalid_breakdown"
  | "missing_cost_account"
  | "missing_tax_account"
  | "missing_discount_account"
  | "missing_shipping_account"
  | "invalid_lines";

export type PurchasePayableLineInput = {
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  shippingAmount: number;
  totalAmount: number;
  costAccountId: string | null;
  taxAccountId: string | null;
  discountAccountId: string | null;
  shippingAccountId: string | null;
  payableAccountId: string | null;
};

function money(value: number) {
  return Math.round(value * 100) / 100;
}

function validAmount(value: number) {
  return Number.isFinite(value) && value >= 0 && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
}

export function buildPurchasePayableJournalLines(input: PurchasePayableLineInput):
  | { ok: true; lines: PurchasePayableLine[]; totalDebit: number; totalCredit: number }
  | { ok: false; error: PurchasePayableLineError } {
  const amounts = [input.subtotal, input.taxAmount, input.discountAmount, input.shippingAmount, input.totalAmount];
  if (amounts.some((value) => !validAmount(value)) || input.subtotal <= 0 || input.totalAmount <= 0) {
    return { ok: false, error: "invalid_breakdown" };
  }
  if (money(input.subtotal + input.taxAmount + input.shippingAmount - input.discountAmount) !== money(input.totalAmount)) {
    return { ok: false, error: "invalid_breakdown" };
  }
  if (!input.costAccountId || !input.payableAccountId) return { ok: false, error: "missing_cost_account" };
  if (input.taxAmount > 0 && !input.taxAccountId) return { ok: false, error: "missing_tax_account" };
  if (input.discountAmount > 0 && !input.discountAccountId) return { ok: false, error: "missing_discount_account" };
  if (input.shippingAmount > 0 && !input.shippingAccountId) return { ok: false, error: "missing_shipping_account" };

  const lines: PurchasePayableLine[] = [
    { account_id: input.costAccountId, debit: money(input.subtotal), credit: 0, description: "Compra o gasto registrado" },
  ];
  if (input.taxAmount > 0 && input.taxAccountId) {
    lines.push({ account_id: input.taxAccountId, debit: money(input.taxAmount), credit: 0, description: "Impuesto de compras" });
  }
  if (input.shippingAmount > 0 && input.shippingAccountId) {
    lines.push({ account_id: input.shippingAccountId, debit: money(input.shippingAmount), credit: 0, description: "Flete de compras" });
  }
  if (input.discountAmount > 0 && input.discountAccountId) {
    lines.push({ account_id: input.discountAccountId, debit: 0, credit: money(input.discountAmount), description: "Descuento de compras" });
  }
  lines.push({ account_id: input.payableAccountId, debit: 0, credit: money(input.totalAmount), description: "Cuenta por pagar a proveedor" });

  const totalDebit = money(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = money(lines.reduce((sum, line) => sum + line.credit, 0));
  const signatures = new Set(lines.map((line) => `${line.account_id}|${line.debit}|${line.credit}|${line.description}`));
  if (lines.length < 2 || totalDebit <= 0 || totalDebit !== totalCredit || signatures.size !== lines.length) {
    return { ok: false, error: "invalid_lines" };
  }
  return { ok: true, lines, totalDebit, totalCredit };
}
