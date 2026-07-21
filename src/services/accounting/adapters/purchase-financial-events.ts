import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { FinancialEventCandidate } from "@/services/accounting/financial-event-engine";

import {
  resolveAccountsPayableSnapshot,
  type PayableSnapshotInvoice,
  type PayableSnapshotItem,
  type PayableSnapshotPurchase,
} from '@/services/accounting/purchase-payable-snapshot';

type SupplierRelation = { name: string | null } | null;

type PurchaseEventRow = {
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
  confirmed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  suppliers: SupplierRelation;
};

type SupplierInvoiceEventRow = {
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
  received_at: string | null;
  created_at: string;
  updated_at: string;
  suppliers: SupplierRelation;
  purchases: { purchase_number: string | null } | null;
};

type AccountsPayableEventRow = {
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
  updated_at: string;
  suppliers: SupplierRelation;
  purchases: PayableSnapshotPurchase;
  supplier_invoices: PayableSnapshotInvoice;
};

type SupplierPaymentEventRow = {
  id: string;
  accounts_payable_id: string;
  supplier_id: string;
  amount: unknown;
  payment_method: string;
  status: string;
  paid_at: string | null;
  voided_at: string | null;
  created_at: string;
  updated_at: string;
  suppliers: SupplierRelation;
  accounts_payable: {
    id: string;
    purchase_id: string | null;
    supplier_invoice_id: string | null;
    total_amount: unknown;
    paid_amount: unknown;
    balance: unknown;
    currency: string | null;
    purchases: { purchase_number: string | null } | null;
    supplier_invoices: { invoice_number: string | null } | null;
  } | null;
};

type PurchaseReturnEventRow = {
  id: string;
  purchase_id: string;
  supplier_id: string;
  accounts_payable_id: string | null;
  return_number: string;
  return_date: string;
  status: string;
  subtotal: unknown;
  tax_amount: unknown;
  total: unknown;
  reason: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  suppliers: SupplierRelation;
  purchases: { purchase_number: string | null; currency: string | null } | null;
};

type SupplierCreditEventRow = {
  id: string;
  supplier_id: string;
  purchase_id: string | null;
  supplier_invoice_id: string | null;
  accounts_payable_id: string | null;
  credit_number: string;
  credit_date: string;
  amount: unknown;
  remaining_amount: unknown;
  status: string;
  reason: string | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
  suppliers: SupplierRelation;
  purchases: { purchase_number: string | null } | null;
  supplier_invoices: { invoice_number: string | null } | null;
};

const purchaseConfirmedStatuses = new Set(["confirmed", "received", "returned"]);
const purchaseCancelledStatuses = new Set(["cancelled"]);
const supplierInvoiceReceivedStatuses = new Set(["received", "posted_to_ap", "paid"]);
const accountsPayableCreatedStatuses = new Set(["pending", "partial", "paid", "overdue"]);

function toNumber(value: unknown) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : 0;
}

function supplierName(supplier: SupplierRelation) {
  return supplier?.name?.trim() || "Proveedor no identificado";
}

function normalizePaymentMethodKey(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["cash", "efectivo", "caja"].includes(normalized)) return "cash";
  if (["card", "tarjeta", "tarjeta de credito", "tarjeta de debito"].includes(normalized)) return "card";
  if (["bank", "bank_transfer", "transferencia", "transferencia bancaria", "deposito", "cheque"].includes(normalized)) return "bank";

  const slug = normalized
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return slug || "bank";
}

function purchaseSnapshot(row: PurchaseEventRow) {
  return {
    supplier_id: row.supplier_id,
    supplier_name: supplierName(row.suppliers),
    purchase_id: row.id,
    purchase_number: row.purchase_number,
    subtotal: toNumber(row.subtotal),
    tax_amount: toNumber(row.tax_amount),
    discount_amount: toNumber(row.discount_amount),
    shipping_amount: toNumber(row.shipping_amount),
    total: toNumber(row.total),
    currency: row.currency,
    status: row.status,
    purchase_date: row.purchase_date,
  };
}

function supplierInvoiceSnapshot(row: SupplierInvoiceEventRow) {
  return {
    supplier_id: row.supplier_id,
    supplier_name: supplierName(row.suppliers),
    purchase_id: row.purchase_id,
    purchase_number: row.purchases?.purchase_number ?? null,
    supplier_invoice_id: row.id,
    invoice_number: row.invoice_number,
    subtotal: toNumber(row.subtotal),
    tax_amount: toNumber(row.tax_amount),
    discount_amount: toNumber(row.discount_amount),
    total: toNumber(row.total),
    currency: row.currency,
    status: row.status,
    invoice_date: row.invoice_date,
    due_date: row.due_date,
  };
}

function supplierPaymentSnapshot(row: SupplierPaymentEventRow) {
  const payable = row.accounts_payable;
  return {
    supplier_id: row.supplier_id,
    supplier_name: supplierName(row.suppliers),
    purchase_id: payable?.purchase_id ?? null,
    purchase_number: payable?.purchases?.purchase_number ?? null,
    supplier_invoice_id: payable?.supplier_invoice_id ?? null,
    invoice_number: payable?.supplier_invoices?.invoice_number ?? null,
    accounts_payable_id: row.accounts_payable_id,
    supplier_payment_id: row.id,
    payment_method: row.payment_method,
    total_amount: toNumber(payable?.total_amount),
    paid_amount: toNumber(payable?.paid_amount),
    balance: toNumber(payable?.balance),
    amount: toNumber(row.amount),
    currency: payable?.currency ?? "HNL",
    status: row.status,
    paid_at: row.paid_at,
  };
}

function purchaseReturnSnapshot(row: PurchaseReturnEventRow) {
  return {
    supplier_id: row.supplier_id,
    supplier_name: supplierName(row.suppliers),
    purchase_id: row.purchase_id,
    purchase_number: row.purchases?.purchase_number ?? null,
    accounts_payable_id: row.accounts_payable_id,
    purchase_return_id: row.id,
    return_number: row.return_number,
    subtotal: toNumber(row.subtotal),
    tax_amount: toNumber(row.tax_amount),
    total: toNumber(row.total),
    amount: toNumber(row.total),
    currency: row.purchases?.currency ?? "HNL",
    status: row.status,
    return_date: row.return_date,
  };
}

function supplierCreditSnapshot(row: SupplierCreditEventRow) {
  return {
    supplier_id: row.supplier_id,
    supplier_name: supplierName(row.suppliers),
    purchase_id: row.purchase_id,
    purchase_number: row.purchases?.purchase_number ?? null,
    supplier_invoice_id: row.supplier_invoice_id,
    invoice_number: row.supplier_invoices?.invoice_number ?? null,
    accounts_payable_id: row.accounts_payable_id,
    supplier_credit_id: row.id,
    credit_number: row.credit_number,
    amount: toNumber(row.amount),
    remaining_amount: toNumber(row.remaining_amount),
    total: toNumber(row.amount),
    currency: "HNL",
    status: row.status,
    credit_date: row.credit_date,
  };
}

async function getPurchaseCandidates(client?: SupabaseClient): Promise<FinancialEventCandidate[]> {
  const supabase = client ?? (await getSupabaseServerClient());
  const { data, error } = await supabase
    .from("purchases")
    .select("id, supplier_id, purchase_number, purchase_date, status, subtotal, tax_amount, discount_amount, shipping_amount, total, currency, confirmed_at, cancelled_at, created_at, updated_at, suppliers(name)")
    .in("status", ["confirmed", "received", "returned", "cancelled"])
    .order("updated_at", { ascending: false })
    .limit(500)
    .returns<PurchaseEventRow[]>();

  if (error) throw new Error(error.message);

  return (data ?? []).flatMap<FinancialEventCandidate>((row) => {
    const amount = toNumber(row.total);
    const snapshot = purchaseSnapshot(row);
    const base = {
      source_type: "purchase" as const,
      source_id: row.id,
      posting_version: "v1",
      amount,
      taxAmount: toNumber(row.tax_amount),
      sourceNumber: row.purchase_number,
      source_snapshot: snapshot,
    };

    if (purchaseConfirmedStatuses.has(row.status)) {
      return [{ ...base, eventType: "purchase_confirmed" as const, event_purpose: "purchase_confirmed" as const, occurred_at: row.confirmed_at ?? row.updated_at ?? row.created_at, eligible: true }];
    }

    if (purchaseCancelledStatuses.has(row.status)) {
      return [{ ...base, eventType: "purchase_cancelled" as const, event_purpose: "purchase_cancelled" as const, occurred_at: row.cancelled_at ?? row.updated_at ?? row.created_at, eligible: true }];
    }

    return [];
  });
}

async function getSupplierInvoiceCandidates(client?: SupabaseClient): Promise<FinancialEventCandidate[]> {
  const supabase = client ?? (await getSupabaseServerClient());
  const { data, error } = await supabase
    .from("supplier_invoices")
    .select("id, supplier_id, purchase_id, invoice_number, invoice_date, due_date, status, subtotal, tax_amount, discount_amount, total, currency, received_at, created_at, updated_at, suppliers(name), purchases(purchase_number)")
    .in("status", ["received", "posted_to_ap", "paid"])
    .order("updated_at", { ascending: false })
    .limit(500)
    .returns<SupplierInvoiceEventRow[]>();

  if (error) throw new Error(error.message);

  return (data ?? [])
    .filter((row) => supplierInvoiceReceivedStatuses.has(row.status))
    .map<FinancialEventCandidate>((row) => ({
      eventType: "supplier_invoice_received",
      source_type: "supplier_invoice",
      source_id: row.id,
      event_purpose: "supplier_invoice_received",
      posting_version: "v1",
      occurred_at: row.received_at ?? row.updated_at ?? row.created_at,
      amount: toNumber(row.total),
      taxAmount: toNumber(row.tax_amount),
      sourceNumber: row.invoice_number,
      eligible: true,
      source_snapshot: supplierInvoiceSnapshot(row),
    }));
}

async function getAccountsPayableCandidates(client?: SupabaseClient): Promise<FinancialEventCandidate[]> {
  const supabase = client ?? (await getSupabaseServerClient());
  const { data, error } = await supabase
    .from("accounts_payable")
    .select("id, supplier_id, purchase_id, supplier_invoice_id, total_amount, paid_amount, balance, due_date, status, currency, created_at, updated_at, suppliers(name), purchases(id, supplier_id, purchase_number, purchase_date, status, subtotal, tax_amount, discount_amount, shipping_amount, total, currency), supplier_invoices(id, supplier_id, purchase_id, invoice_number, invoice_date, due_date, status, subtotal, tax_amount, discount_amount, total, currency)")
    .in("status", ["pending", "partial", "paid", "overdue"])
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<AccountsPayableEventRow[]>();

  if (error) throw new Error(error.message);

  const rows = (data ?? []).filter((row) => accountsPayableCreatedStatuses.has(row.status));
  const purchaseIds = [...new Set(rows.map((row) => row.purchase_id).filter((id): id is string => Boolean(id)))];
  const itemsByPurchase = new Map<string, PayableSnapshotItem[]>();

  if (purchaseIds.length > 0) {
    const { data: itemRows, error: itemsError } = await supabase
      .from("purchase_items")
      .select("purchase_id, quantity, unit_cost, tax_amount, discount_amount")
      .in("purchase_id", purchaseIds)
      .returns<Array<PayableSnapshotItem & { purchase_id: string }>>();

    if (itemsError) throw new Error(itemsError.message);
    for (const item of itemRows ?? []) {
      itemsByPurchase.set(item.purchase_id, [...(itemsByPurchase.get(item.purchase_id) ?? []), item]);
    }
  }

  return rows.map<FinancialEventCandidate>((row) => {
    const resolved = resolveAccountsPayableSnapshot({
      id: row.id,
      supplier_id: row.supplier_id,
      purchase_id: row.purchase_id,
      supplier_invoice_id: row.supplier_invoice_id,
      total_amount: row.total_amount,
      paid_amount: row.paid_amount,
      balance: row.balance,
      due_date: row.due_date,
      status: row.status,
      currency: row.currency,
      created_at: row.created_at,
      supplier: row.suppliers,
      purchase: row.purchases,
      supplierInvoice: row.supplier_invoices,
      purchaseItems: row.purchase_id ? itemsByPurchase.get(row.purchase_id) ?? [] : [],
    });

    return {
      eventType: "accounts_payable_created",
      source_type: "accounts_payable",
      source_id: row.id,
      event_purpose: "accounts_payable_created",
      posting_version: "v1",
      occurred_at: row.created_at,
      amount: toNumber(row.total_amount),
      taxAmount: resolved.taxAmount,
      sourceNumber: resolved.sourceNumber,
      eligible: true,
      source_snapshot: resolved.snapshot,
      validation_errors: resolved.validationErrors,
    };
  });
}

async function getSupplierPaymentCandidates(client?: SupabaseClient): Promise<FinancialEventCandidate[]> {
  const supabase = client ?? (await getSupabaseServerClient());
  const { data, error } = await supabase
    .from("supplier_payments")
    .select("id, accounts_payable_id, supplier_id, amount, payment_method, status, paid_at, voided_at, created_at, updated_at, suppliers(name), accounts_payable(id, purchase_id, supplier_invoice_id, total_amount, paid_amount, balance, currency, purchases(purchase_number), supplier_invoices(invoice_number))")
    .in("status", ["paid", "voided"])
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<SupplierPaymentEventRow[]>();

  if (error) throw new Error(error.message);

  return (data ?? []).flatMap<FinancialEventCandidate>((row) => {
    const snapshot = supplierPaymentSnapshot(row);
    const base = {
      source_type: "supplier_payment" as const,
      source_id: row.id,
      posting_version: "v1",
      amount: toNumber(row.amount),
      paymentMethod: `supplier_payment_${normalizePaymentMethodKey(row.payment_method)}`,
      sourceNumber: row.accounts_payable?.supplier_invoices?.invoice_number ?? row.accounts_payable?.purchases?.purchase_number ?? row.id,
      source_snapshot: snapshot,
      eligible: true,
    };

    if (row.status === "paid") return [{ ...base, eventType: "supplier_payment", event_purpose: "supplier_payment", occurred_at: row.paid_at ?? row.created_at }];
    if (row.status === "voided") return [{ ...base, eventType: "supplier_payment_cancelled", event_purpose: "supplier_payment_cancelled", occurred_at: row.voided_at ?? row.updated_at ?? row.created_at }];
    return [];
  });
}

async function getPurchaseReturnCandidates(client?: SupabaseClient): Promise<FinancialEventCandidate[]> {
  const supabase = client ?? (await getSupabaseServerClient());
  const { data, error } = await supabase
    .from("purchase_returns")
    .select("id, purchase_id, supplier_id, accounts_payable_id, return_number, return_date, status, subtotal, tax_amount, total, reason, confirmed_at, created_at, updated_at, suppliers(name), purchases(purchase_number, currency)")
    .eq("status", "confirmed")
    .order("return_date", { ascending: false })
    .limit(500)
    .returns<PurchaseReturnEventRow[]>();

  if (error) throw new Error(error.message);

  return (data ?? []).map<FinancialEventCandidate>((row) => ({
    eventType: "purchase_return",
    source_type: "purchase_return",
    source_id: row.id,
    event_purpose: "purchase_return",
    posting_version: "v1",
    occurred_at: row.confirmed_at ?? row.updated_at ?? row.created_at,
    amount: toNumber(row.total),
    taxAmount: toNumber(row.tax_amount),
    sourceNumber: row.return_number,
    eligible: true,
    source_snapshot: purchaseReturnSnapshot(row),
  }));
}

async function getSupplierCreditCandidates(client?: SupabaseClient): Promise<FinancialEventCandidate[]> {
  const supabase = client ?? (await getSupabaseServerClient());
  const { data, error } = await supabase
    .from("supplier_credits")
    .select("id, supplier_id, purchase_id, supplier_invoice_id, accounts_payable_id, credit_number, credit_date, amount, remaining_amount, status, reason, applied_at, created_at, updated_at, suppliers(name), purchases(purchase_number), supplier_invoices(invoice_number)")
    .in("status", ["open", "applied"])
    .order("credit_date", { ascending: false })
    .limit(500)
    .returns<SupplierCreditEventRow[]>();

  if (error) throw new Error(error.message);

  return (data ?? []).map<FinancialEventCandidate>((row) => ({
    eventType: "supplier_credit",
    source_type: "supplier_credit",
    source_id: row.id,
    event_purpose: "supplier_credit",
    posting_version: "v1",
    occurred_at: row.applied_at ?? row.updated_at ?? row.created_at,
    amount: toNumber(row.amount),
    sourceNumber: row.credit_number,
    eligible: true,
    source_snapshot: supplierCreditSnapshot(row),
  }));
}

export async function getPurchaseFinancialEventCandidates(client?: SupabaseClient): Promise<FinancialEventCandidate[]> {
  const [purchases, supplierInvoices, accountsPayable, supplierPayments, purchaseReturns, supplierCredits] = await Promise.all([
    getPurchaseCandidates(client),
    getSupplierInvoiceCandidates(client),
    getAccountsPayableCandidates(client),
    getSupplierPaymentCandidates(client),
    getPurchaseReturnCandidates(client),
    getSupplierCreditCandidates(client),
  ]);

  return [...purchases, ...supplierInvoices, ...accountsPayable, ...supplierPayments, ...purchaseReturns, ...supplierCredits];
}
