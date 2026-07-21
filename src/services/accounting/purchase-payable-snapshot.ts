export type PayableSnapshotSupplier = { name: string | null } | null;

export type PayableSnapshotPurchase = {
  id: string;
  supplier_id: string;
  purchase_number: string;
  purchase_date: string;
  status: string;
  subtotal: unknown;
  tax_amount: unknown;
  discount_amount: unknown;
  shipping_amount: unknown;
  total: unknown;
  currency: string;
} | null;

export type PayableSnapshotInvoice = {
  id: string;
  supplier_id: string;
  purchase_id: string | null;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  status: string;
  subtotal: unknown;
  tax_amount: unknown;
  discount_amount: unknown;
  total: unknown;
  currency: string;
} | null;

export type PayableSnapshotItem = {
  quantity: unknown;
  unit_cost: unknown;
  tax_amount: unknown;
  discount_amount: unknown;
};

export type PayableSnapshotInput = {
  id: string;
  supplier_id: string;
  purchase_id: string | null;
  supplier_invoice_id: string | null;
  total_amount: unknown;
  paid_amount: unknown;
  balance: unknown;
  due_date: string | null;
  status: string;
  currency: string;
  created_at: string;
  supplier: PayableSnapshotSupplier;
  purchase: PayableSnapshotPurchase;
  supplierInvoice: PayableSnapshotInvoice;
  purchaseItems: PayableSnapshotItem[];
};

export type PayableFiscalSource = "supplier_invoice" | "purchase" | "purchase_items" | "accounts_payable_total";

export type ResolvedPayableSnapshot = {
  snapshot: Record<string, unknown>;
  taxAmount: number | null;
  sourceNumber: string;
  validationErrors: string[];
};

const validInvoiceStatuses = new Set(["received", "posted_to_ap", "paid"]);
const validPurchaseStatuses = new Set(["confirmed", "received", "returned"]);
const missingBreakdownMessage = 'La cuenta por pagar no tiene un desglose fiscal verificable.';

function money(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function normalizedCurrency(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function fiscalTotal(subtotal: number, taxAmount: number, discountAmount: number, shippingAmount: number) {
  return money(subtotal + taxAmount + shippingAmount - discountAmount);
}

function fiscalValues(input: { subtotal: unknown; tax_amount: unknown; discount_amount: unknown; shipping_amount?: unknown; total: unknown }) {
  const subtotal = money(input.subtotal);
  const taxAmount = money(input.tax_amount);
  const discountAmount = money(input.discount_amount);
  const shippingAmount = money(input.shipping_amount);
  const total = money(input.total);
  return { subtotal, taxAmount, discountAmount, shippingAmount, total, reconciles: fiscalTotal(subtotal, taxAmount, discountAmount, shippingAmount) === total };
}

export function resolveAccountsPayableSnapshot(input: PayableSnapshotInput): ResolvedPayableSnapshot {
  const payableTotal = money(input.total_amount);
  const payableCurrency = normalizedCurrency(input.currency);
  const invoice = input.supplierInvoice;
  const purchase = input.purchase;
  let fiscalSource: PayableFiscalSource = 'accounts_payable_total';
  let subtotal: number | null = null;
  let taxAmount: number | null = null;
  let discountAmount: number | null = null;
  let shippingAmount: number | null = null;
  let documentNumber: string | null = null;
  let documentDate: string | null = null;

  const invoiceValues = invoice ? fiscalValues(invoice) : null;
  const validInvoice = Boolean(
    invoice &&
      input.supplier_invoice_id === invoice.id &&
      invoice.supplier_id === input.supplier_id &&
      (input.purchase_id === null || invoice.purchase_id === input.purchase_id) &&
      validInvoiceStatuses.has(invoice.status) &&
      normalizedCurrency(invoice.currency) === payableCurrency &&
      invoiceValues?.reconciles &&
      invoiceValues.total === payableTotal,
  );

  if (validInvoice && invoice && invoiceValues) {
    fiscalSource = 'supplier_invoice';
    ({ subtotal, taxAmount, discountAmount } = invoiceValues);
    shippingAmount = 0;
    documentNumber = invoice.invoice_number;
    documentDate = invoice.invoice_date;
  } else {
    const purchaseValues = purchase ? fiscalValues(purchase) : null;
    const validPurchase = Boolean(
      purchase &&
        input.purchase_id === purchase.id &&
        purchase.supplier_id === input.supplier_id &&
        validPurchaseStatuses.has(purchase.status) &&
        normalizedCurrency(purchase.currency) === payableCurrency &&
        purchaseValues?.reconciles &&
        purchaseValues.total === payableTotal,
    );

    if (validPurchase && purchase && purchaseValues) {
      fiscalSource = 'purchase';
      ({ subtotal, taxAmount, discountAmount, shippingAmount } = purchaseValues);
      documentNumber = purchase.purchase_number;
      documentDate = purchase.purchase_date;
    } else if (purchase && input.purchaseItems.length > 0) {
      const itemSubtotal = money(input.purchaseItems.reduce((sum, item) => sum + money(item.quantity) * money(item.unit_cost), 0));
      const itemTax = money(input.purchaseItems.reduce((sum, item) => sum + money(item.tax_amount), 0));
      const itemDiscount = money(input.purchaseItems.reduce((sum, item) => sum + money(item.discount_amount), 0));
      const purchaseShipping = money(purchase.shipping_amount);
      if (input.purchase_id === purchase.id && purchase.supplier_id === input.supplier_id && validPurchaseStatuses.has(purchase.status) && normalizedCurrency(purchase.currency) === payableCurrency && fiscalTotal(itemSubtotal, itemTax, itemDiscount, purchaseShipping) === payableTotal) {
        fiscalSource = 'purchase_items';
        subtotal = itemSubtotal;
        taxAmount = itemTax;
        discountAmount = itemDiscount;
        shippingAmount = purchaseShipping;
        documentNumber = purchase.purchase_number;
        documentDate = purchase.purchase_date;
      }
    }
  }

  const complete = fiscalSource !== 'accounts_payable_total';
  const sourceNumber = documentNumber ?? invoice?.invoice_number ?? purchase?.purchase_number ?? input.id;
  return {
    snapshot: {
      accounts_payable_id: input.id,
      purchase_id: input.purchase_id,
      supplier_invoice_id: input.supplier_invoice_id,
      vendor_id: input.supplier_id,
      supplier_id: input.supplier_id,
      supplier_name: input.supplier?.name?.trim() || 'Proveedor no identificado',
      subtotal,
      tax_amount: taxAmount,
      discount_amount: discountAmount,
      shipping_amount: shippingAmount,
      total_amount: payableTotal,
      paid_amount: money(input.paid_amount),
      balance: money(input.balance),
      currency: payableCurrency,
      document_number: documentNumber,
      document_date: documentDate,
      purchase_number: purchase?.purchase_number ?? null,
      invoice_number: invoice?.invoice_number ?? null,
      due_date: input.due_date,
      source_type: 'accounts_payable',
      source_id: input.id,
      payment_status: input.status,
      status: input.status,
      fiscal_breakdown_status: complete ? 'complete' : 'missing',
      fiscal_source: fiscalSource,
      fiscal_metadata: {
        invoice_status: invoice?.status ?? null,
        purchase_status: purchase?.status ?? null,
        purchase_items_count: input.purchaseItems.length,
        reconciled_total: complete,
      },
    },
    taxAmount,
    sourceNumber,
    validationErrors: complete ? [] : [missingBreakdownMessage],
  };
}

export const accountsPayableMissingFiscalBreakdownMessage = missingBreakdownMessage;
