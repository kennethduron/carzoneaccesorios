import "server-only";

import type { AppRole } from "@/types/auth";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const autoCentroExt100Incident = Object.freeze({
  customerId: "ac53278c-e748-4f71-ab52-c1bac01624a7",
  productId: "2a54e6ec-fe92-4ff9-aa26-c0292919a686",
  productSku: "EXT-100",
  invoiceId: "e78f5792-6e92-42f7-82b0-9eed9c651b15",
  orderId: "1de7894b-21e1-4a4c-8be7-0460f9b08164",
  movementId: "69c13dbf-318e-4d24-8992-a2b92a1cb656",
  receivableId: "16b429fb-b196-44f4-bbaf-b555104536ce",
  cancellationReason: "equivocacion en codigo facturado",
  quantity: 1,
  stock: 3,
  receivableBalance: 400,
});

const authorizedRecoveryRoles = new Set<AppRole>([
  "technical_owner",
  "business_owner",
  "admin",
]);

export function isCommercialReversalRecoveryRole(role: AppRole) {
  return authorizedRecoveryRoles.has(role);
}

type AccountingRow = {
  event_purpose: string;
  journal_entries: { status: string } | Array<{ status: string }> | null;
};

export async function getPendingAutoCentroExt100Recovery(role: AppRole) {
  if (!isCommercialReversalRecoveryRole(role)) {
    return null;
  }

  const incident = autoCentroExt100Incident;
  const supabase = await getSupabaseServerClient();
  const [invoice, order, product, movement, latestMovements, saleMovements, inverseMovements, receivable, payments, receivablePayments, accounting] = await Promise.all([
    supabase.from("invoices")
      .select("id,order_id,customer_id,status,cancellation_reason")
      .eq("id", incident.invoiceId).maybeSingle(),
    supabase.from("orders")
      .select("id,customer_id,status,tracking_status,payment_method,order_reservation_status,commercial_reversal_invoice_id")
      .eq("id", incident.orderId).maybeSingle(),
    supabase.from("products")
      .select("id,sku,stock,reserved_stock")
      .eq("id", incident.productId).maybeSingle(),
    supabase.from("inventory_movements")
      .select("id,product_id,reference_type,reference_id,movement_type,quantity")
      .eq("id", incident.movementId).maybeSingle(),
    supabase.from("inventory_movements")
      .select("id")
      .eq("product_id", incident.productId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1),
    supabase.from("inventory_movements")
      .select("id,product_id,quantity")
      .eq("reference_type", "orders")
      .eq("reference_id", incident.orderId)
      .eq("movement_type", "sale")
      .lt("quantity", 0),
    supabase.from("inventory_movements")
      .select("id")
      .eq("reversal_of_movement_id", incident.movementId),
    supabase.from("accounts_receivable")
      .select("id,order_id,status,original_amount,balance_due")
      .eq("id", incident.receivableId).maybeSingle(),
    supabase.from("payments").select("id").eq("order_id", incident.orderId),
    supabase.from("accounts_receivable_payments")
      .select("id")
      .eq("receivable_id", incident.receivableId),
    supabase.from("accounting_outbox_v2")
      .select("event_purpose,journal_entries(status)")
      .or(`and(source_type.eq.order,source_id.eq.${incident.orderId}),and(source_type.eq.inventory_movement,source_id.eq.${incident.movementId})`),
  ]);

  if ([invoice, order, product, movement, latestMovements, saleMovements, inverseMovements, receivable, payments, receivablePayments, accounting]
    .some((result) => result.error)) {
    return null;
  }

  const invoiceRow = invoice.data;
  const orderRow = order.data;
  const productRow = product.data;
  const movementRow = movement.data;
  const receivableRow = receivable.data;
  const accountingRows = (accounting.data ?? []) as AccountingRow[];
  const originalAccounting = accountingRows.filter((row) =>
    row.event_purpose === "sale_recognized" || row.event_purpose === "inventory_cogs"
  );
  const compensations = accountingRows.filter((row) =>
    row.event_purpose === "sale_compensation" || row.event_purpose === "inventory_cogs_compensation"
  );
  const accountingStillActive = originalAccounting.length === 2 && originalAccounting.every((row) => {
    const journal = Array.isArray(row.journal_entries) ? row.journal_entries[0] : row.journal_entries;
    return !journal || journal.status === "borrador" || journal.status === "publicada";
  });

  const eligible = Boolean(
    invoiceRow?.id === incident.invoiceId
      && invoiceRow.order_id === incident.orderId
      && invoiceRow.customer_id === incident.customerId
      && ["anulada", "cancelled"].includes(invoiceRow.status)
      && invoiceRow.cancellation_reason?.trim() === incident.cancellationReason
      && orderRow?.id === incident.orderId
      && orderRow.customer_id === incident.customerId
      && ["entregado", "delivered"].includes(orderRow.status)
      && ["entregado", "delivered"].includes(orderRow.tracking_status)
      && orderRow.order_reservation_status === "not_required"
      && orderRow.commercial_reversal_invoice_id === null
      && productRow?.id === incident.productId
      && productRow.sku === incident.productSku
      && productRow.stock === incident.stock
      && productRow.reserved_stock === 0
      && movementRow?.id === incident.movementId
      && movementRow.product_id === incident.productId
      && movementRow.reference_type === "orders"
      && movementRow.reference_id === incident.orderId
      && movementRow.movement_type === "sale"
      && movementRow.quantity === -incident.quantity
      && latestMovements.data?.[0]?.id === incident.movementId
      && saleMovements.data?.length === 1
      && inverseMovements.data?.length === 0
      && receivableRow?.id === incident.receivableId
      && receivableRow.order_id === incident.orderId
      && ["open", "overdue"].includes(receivableRow.status)
      && Number(receivableRow.original_amount) === incident.receivableBalance
      && Number(receivableRow.balance_due) === incident.receivableBalance
      && payments.data?.length === 0
      && receivablePayments.data?.length === 0
      && accountingStillActive
      && compensations.length === 0
  );

  return eligible
    ? { invoiceId: incident.invoiceId, cancellationReason: incident.cancellationReason }
    : null;
}
