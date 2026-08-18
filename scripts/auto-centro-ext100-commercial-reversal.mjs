import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const INCIDENT = Object.freeze({
  projectRef: "mbowrapstbufzzfefipn",
  customerId: "ac53278c-e748-4f71-ab52-c1bac01624a7",
  customerName: "Auto Centro Plaza Express",
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

const execute = process.argv.includes("--execute");
const dryRun = process.argv.includes("--dry-run") || !execute;
assert.equal(execute && dryRun, false, "Choose either --dry-run or --execute.");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(url && serviceKey, "Secure Supabase configuration is required.");
const parsedUrl = new URL(url);
assert.equal(parsedUrl.protocol, "https:");
assert.equal(parsedUrl.hostname, `${INCIDENT.projectRef}.supabase.co`, "Unexpected Supabase project; denied.");

const readonly = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function one(table, columns, id) {
  const result = await readonly.from(table).select(columns).eq("id", id).single();
  assert.ifError(result.error);
  return result.data;
}

async function evaluate() {
  const [invoice, order, customer, product, movement, receivable] = await Promise.all([
    one("invoices", "id,order_id,customer_id,status,cancellation_reason,cancelled_at", INCIDENT.invoiceId),
    one("orders", "id,customer_id,status,tracking_status,payment_method,order_reservation_status", INCIDENT.orderId),
    one("customers", "id,contact_name,business_name", INCIDENT.customerId),
    one("products", "id,sku,stock,reserved_stock", INCIDENT.productId),
    one("inventory_movements", "id,product_id,reference_type,reference_id,movement_type,quantity,created_at", INCIDENT.movementId),
    one("accounts_receivable", "id,order_id,status,original_amount,balance_due", INCIDENT.receivableId),
  ]);

  const [productMovements, orderSaleMovements, payments, receivablePayments, accounting] = await Promise.all([
    readonly.from("inventory_movements")
      .select("id,movement_type,quantity,created_at,reference_type,reference_id")
      .eq("product_id", INCIDENT.productId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }),
    readonly.from("inventory_movements")
      .select("id,product_id,movement_type,quantity")
      .eq("reference_type", "orders").eq("reference_id", INCIDENT.orderId)
      .eq("movement_type", "sale").lt("quantity", 0),
    readonly.from("payments").select("id,status,payment_status,amount").eq("order_id", INCIDENT.orderId),
    readonly.from("accounts_receivable_payments").select("id,amount,voided_at").eq("receivable_id", INCIDENT.receivableId),
    readonly.from("accounting_outbox_v2")
      .select("id,source_type,source_id,event_purpose,status,journal_entry_id,journal_entries(status)")
      .or(`and(source_type.eq.order,source_id.eq.${INCIDENT.orderId}),and(source_type.eq.inventory_movement,source_id.eq.${INCIDENT.movementId})`),
  ]);
  for (const result of [productMovements, orderSaleMovements, payments, receivablePayments, accounting]) {
    assert.ifError(result.error);
  }

  const customerMatches = [customer.business_name, customer.contact_name]
    .some((value) => value?.trim() === INCIDENT.customerName);
  const originalAccounting = accounting.data.filter((row) =>
    row.event_purpose === "sale_recognized" || row.event_purpose === "inventory_cogs"
  );
  const compensation = accounting.data.filter((row) =>
    row.event_purpose === "sale_compensation" || row.event_purpose === "inventory_cogs_compensation"
  );
  const journalStillActive = originalAccounting.every((row) => {
    const journal = Array.isArray(row.journal_entries) ? row.journal_entries[0] : row.journal_entries;
    return !journal || ["borrador", "publicada"].includes(journal.status);
  });

  const checks = {
    exactCustomer: customer.id === INCIDENT.customerId && customerMatches,
    exactInvoice: invoice.id === INCIDENT.invoiceId && invoice.order_id === INCIDENT.orderId
      && invoice.customer_id === INCIDENT.customerId && ["anulada", "cancelled"].includes(invoice.status)
      && invoice.cancellation_reason?.trim() === INCIDENT.cancellationReason,
    exactOrder: order.id === INCIDENT.orderId && order.customer_id === INCIDENT.customerId
      && ["entregado", "delivered"].includes(order.status)
      && ["entregado", "delivered"].includes(order.tracking_status),
    exactInventory: product.id === INCIDENT.productId && product.sku === INCIDENT.productSku
      && product.stock === INCIDENT.stock && product.reserved_stock === 0
      && movement.id === INCIDENT.movementId && movement.product_id === INCIDENT.productId
      && movement.reference_type === "orders" && movement.reference_id === INCIDENT.orderId
      && movement.movement_type === "sale" && movement.quantity === -INCIDENT.quantity
      && orderSaleMovements.data.length === 1,
    noLaterProductMovement: productMovements.data[0]?.id === INCIDENT.movementId,
    unpaidReceivable: receivable.id === INCIDENT.receivableId && receivable.order_id === INCIDENT.orderId
      && ["open", "overdue"].includes(receivable.status)
      && Number(receivable.original_amount) === INCIDENT.receivableBalance
      && Number(receivable.balance_due) === INCIDENT.receivableBalance
      && receivablePayments.data.length === 0,
    noPayment: payments.data.length === 0,
    accountingActiveAndUnreversed: originalAccounting.length === 2
      && compensation.length === 0 && journalStillActive,
  };

  return {
    eligible: Object.values(checks).every(Boolean),
    checks,
    currentStock: product.stock,
    expectedReversal: INCIDENT.quantity,
    expectedFinalStock: product.stock + INCIDENT.quantity,
    expectedReceivableEffect: "L400 open -> cancelled, balance L0",
    expectedAccountingEffect: "sale + COGS/receivable compensation exactly once",
  };
}

const assessment = await evaluate();
console.log(JSON.stringify({
  operation: "AUTO_CENTRO_EXT100_COMMERCIAL_REVERSAL",
  mode: execute ? "EXECUTE" : "READ_ONLY_DRY_RUN",
  productionWrites: execute ? "PENDING_AUTHORIZED_RPC" : 0,
  ...assessment,
}, null, 2));

if (!execute) process.exit(assessment.eligible ? 0 : 2);

assert.equal(assessment.eligible, true, "REAL_REPAIR_DENIED: preconditions changed.");
assert.equal(
  process.env.ALLOW_PRODUCTION_COMMERCIAL_REVERSAL,
  "AUTO-CENTRO-EXT100-APPROVED",
  "Explicit production repair authorization is missing.",
);
assert.ok(
  process.argv.includes("--confirm=AUTO-CENTRO-EXT100"),
  "Typed incident confirmation is missing.",
);
const operatorToken = process.env.CARZONE_REPAIR_USER_ACCESS_TOKEN;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
assert.ok(operatorToken && anonKey, "A secure authorized operator session is required.");

const operator = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${operatorToken}` } },
});
const result = await operator.rpc("cancel_sale_invoice_v1", {
  p_invoice_id: INCIDENT.invoiceId,
  p_reason: INCIDENT.cancellationReason,
  p_recovery_mode: true,
  p_recovery_expected: {
    order_id: INCIDENT.orderId,
    order_status: "entregado",
    customer_id: INCIDENT.customerId,
    product_id: INCIDENT.productId,
    original_movement_id: INCIDENT.movementId,
    original_movement_count: 1,
    quantity: INCIDENT.quantity,
    current_stock: INCIDENT.stock,
    receivable_id: INCIDENT.receivableId,
    receivable_balance: INCIDENT.receivableBalance,
    cancellation_reason: INCIDENT.cancellationReason,
  },
});
assert.ifError(result.error);
console.log(JSON.stringify({ status: result.data?.status, productionRepair: "COMPLETED" }));
