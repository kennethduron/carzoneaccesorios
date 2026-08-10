import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import type {
  AdminPurchase,
  PurchaseItemWithProduct,
  PurchasePayableSummary,
  PurchaseReturn,
  PurchaseSupplierInvoiceSummary,
  PurchasesSummary,
} from "@/types/purchases";

type PurchaseQueryRow = Omit<AdminPurchase, "supplier_name" | "supplier_tax_id" | "items" | "returns" | "payable" | "supplier_invoice"> & {
  suppliers: { name: string; tax_id: string | null } | null;
  purchase_items: Array<
    Omit<PurchaseItemWithProduct, "product_name" | "product_sku"> & {
      products: { name: string; sku: string | null } | null;
    }
  > | null;
  purchase_returns: PurchaseReturn[] | null;
  accounts_payable: PurchasePayableSummary[] | null;
  supplier_invoices: PurchaseSupplierInvoiceSummary[] | null;
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function normalizeReturn(row: PurchaseReturn): PurchaseReturn {
  return {
    ...row,
    subtotal: toNumber(row.subtotal),
    tax_amount: toNumber(row.tax_amount),
    total: toNumber(row.total),
  };
}

function normalizePurchase(row: PurchaseQueryRow): AdminPurchase {
  const activePayable = (row.accounts_payable ?? []).find((item) => item.status !== "cancelled") ?? null;
  const activeInvoice = (row.supplier_invoices ?? []).find((item) => item.status !== "cancelled") ?? null;
  return {
    ...row,
    subtotal: toNumber(row.subtotal),
    tax_amount: toNumber(row.tax_amount),
    discount_amount: toNumber(row.discount_amount),
    shipping_amount: toNumber(row.shipping_amount),
    total: toNumber(row.total),
    supplier_name: row.suppliers?.name ?? "Proveedor",
    supplier_tax_id: row.suppliers?.tax_id ?? null,
    items: (row.purchase_items ?? []).map((item) => ({
      ...item,
      quantity: toNumber(item.quantity),
      unit_cost: toNumber(item.unit_cost),
      tax_amount: toNumber(item.tax_amount),
      discount_amount: toNumber(item.discount_amount),
      total_cost: toNumber(item.total_cost),
      product_name: item.products?.name ?? null,
      product_sku: item.products?.sku ?? null,
    })),
    returns: (row.purchase_returns ?? []).map(normalizeReturn).sort((left, right) => right.return_date.localeCompare(left.return_date)),
    payable: activePayable ? {
      ...activePayable,
      total_amount: toNumber(activePayable.total_amount),
      paid_amount: toNumber(activePayable.paid_amount),
      balance: toNumber(activePayable.balance),
    } : null,
    supplier_invoice: activeInvoice,
  };
}

export async function getPurchaseApAutomationConfig() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("purchase_feature_flags")
    .select("enabled, version, enabled_at")
    .eq("key", "purchase_ap_automation_v1")
    .maybeSingle<{ enabled: boolean; version: number; enabled_at: string | null }>();

  if (error) throw new Error(error.message);
  return { enabled: data?.enabled ?? false, version: data?.version ?? 1, enabledAt: data?.enabled_at ?? null };
}

export async function getAdminPurchases(): Promise<{ purchases: AdminPurchase[]; summary: PurchasesSummary }> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("purchases")
    .select(
      `
      id,
      supplier_id,
      purchase_number,
      purchase_date,
      status,
      subtotal,
      tax_amount,
      discount_amount,
      shipping_amount,
      total,
      currency,
      notes,
      created_by,
      confirmed_by,
      confirmed_at,
      payment_condition,
      confirmed_due_date,
      confirmation_request_key,
      confirmation_fingerprint,
      initial_supplier_payment_id,
      cancellation_request_key,
      cancelled_by,
      cancelled_at,
      created_at,
      updated_at,
      suppliers(name, tax_id),
      purchase_items(
        id,
        purchase_id,
        product_id,
        description,
        quantity,
        unit_cost,
        tax_amount,
        discount_amount,
        total_cost,
        inventory_movement_id,
        created_at,
        products(name, sku)
      ),
      purchase_returns(
        id,
        purchase_id,
        supplier_id,
        accounts_payable_id,
        return_number,
        return_date,
        status,
        subtotal,
        tax_amount,
        total,
        reason,
        created_by,
        confirmed_by,
        confirmed_at,
        cancelled_by,
        cancelled_at,
        created_at,
        updated_at
      ),
      accounts_payable(
        id,
        status,
        total_amount,
        paid_amount,
        balance,
        due_date,
        automation_source
      ),
      supplier_invoices(
        id,
        invoice_number,
        due_date,
        status
      )
    `,
    )
    .order("purchase_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<PurchaseQueryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const purchases = (data ?? []).map(normalizePurchase);
  return {
    purchases,
    summary: {
      totalDraft: purchases.filter((purchase) => purchase.status === "draft").length,
      totalConfirmed: purchases.filter((purchase) => purchase.status === "confirmed").length,
      totalCancelled: purchases.filter((purchase) => purchase.status === "cancelled").length,
      totalReturned: purchases.filter((purchase) => purchase.status === "returned").length,
      totalAmount: purchases.filter((purchase) => purchase.status !== "cancelled").reduce((sum, purchase) => sum + purchase.total, 0),
    },
  };
}

export async function getPurchaseById(purchaseId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("purchases")
    .select("id, supplier_id, purchase_number, purchase_date, status, subtotal, tax_amount, discount_amount, shipping_amount, total, currency, notes, created_by, confirmed_by, confirmed_at, payment_condition, confirmed_due_date, confirmation_request_key, confirmation_fingerprint, initial_supplier_payment_id, cancellation_request_key, cancelled_by, cancelled_at, created_at, updated_at")
    .eq("id", purchaseId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export async function getPurchaseOptions() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("purchases")
    .select("id, supplier_id, purchase_number, status, total")
    .neq("status", "cancelled")
    .order("purchase_date", { ascending: false })
    .limit(300)
    .returns<Array<{ id: string; supplier_id: string; purchase_number: string; status: string; total: unknown }>>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => ({ ...row, total: toNumber(row.total) }));
}
