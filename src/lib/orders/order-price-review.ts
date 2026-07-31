import type {
  AdminOrderRow,
  AuthorizedPriceAdjustment,
  OrderPriceReview,
} from "@/types/orders";

const MONEY_TOLERANCE = 0.005;
const AUTHORIZED_OVERRIDE_ROLES = new Set(["technical_owner", "business_owner", "admin"]);
const IMMUTABLE_ORDER_STATUSES = new Set(["paid", "entregado", "delivered", "cancelado", "cancelled"]);
const CONFIRMED_PAYMENT_STATUSES = new Set(["approved", "confirmed", "paid", "rejected", "refunded"]);

export type OrderPriceAuditLineChange = {
  orderItemId: string;
  automaticUnitPrice: number;
  previousUnitPrice: number;
  finalUnitPrice: number;
};

export type OrderPriceAuditEvidence = {
  auditId: string;
  action: "sale.commercial_terms.adjusted" | "sale.price_override.confirmed";
  actorName: string | null;
  actorRole: string;
  createdAt: string;
  versionAfter: number | null;
  note: string | null;
  changes: OrderPriceAuditLineChange[];
};

export type OrderPriceInvoiceEvidence = {
  subtotal: number;
  tax: number;
  shippingFee: number;
  cashOnDeliveryFee: number;
  smallOrderFee: number;
  discountTotal: number;
  total: number;
  items: Array<{
    orderItemId: string | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }>;
};

export type OrderPriceReviewEvidence = {
  audits: OrderPriceAuditEvidence[];
  invoice: OrderPriceInvoiceEvidence | null;
};

function moneyMatches(left: number, right: number) {
  return Math.abs(Number(left) - Number(right)) <= MONEY_TOLERANCE;
}

export function automaticUnitPrice(item: AdminOrderRow["order_items"][number]) {
  return item.applied_price_mode === "wholesale"
    ? Number(item.wholesale_price_snapshot)
    : Number(item.retail_price_snapshot);
}

export function isLegitimateWholesaleFallback(
  order: Pick<AdminOrderRow, "price_mode">,
  item: AdminOrderRow["order_items"][number],
) {
  if (order.price_mode !== "wholesale" || item.applied_price_mode !== "retail") return false;
  const retail = Number(item.retail_price_snapshot);
  const wholesale = Number(item.wholesale_price_snapshot);
  const wholesaleIsValid = wholesale > 0 && (retail <= 0 || wholesale <= retail);
  return !wholesaleIsValid;
}

function invoiceMatchesOrder(order: AdminOrderRow, invoice: OrderPriceInvoiceEvidence | null) {
  if (!order.invoice_id) return null;
  if (!invoice) return false;
  if (
    !moneyMatches(invoice.subtotal, order.subtotal)
    || !moneyMatches(invoice.tax, order.tax)
    || !moneyMatches(invoice.shippingFee, order.shipping_fee)
    || !moneyMatches(invoice.cashOnDeliveryFee, order.cash_on_delivery_fee)
    || !moneyMatches(invoice.smallOrderFee, order.small_order_fee)
    || !moneyMatches(invoice.discountTotal, order.discount_total)
    || !moneyMatches(invoice.total, order.total)
    || invoice.items.length !== order.order_items.length
  ) return false;

  return order.order_items.every((item) => {
    const invoiceItem = invoice.items.find((candidate) => candidate.orderItemId === item.id);
    return Boolean(
      invoiceItem
      && moneyMatches(invoiceItem.quantity, item.quantity)
      && moneyMatches(invoiceItem.unitPrice, item.unit_price)
      && moneyMatches(invoiceItem.lineTotal, item.line_total),
    );
  });
}

function latestChangeByLine(audits: OrderPriceAuditEvidence[]) {
  const result = new Map<string, { audit: OrderPriceAuditEvidence; change: OrderPriceAuditLineChange }>();
  for (const audit of [...audits].sort((left, right) => {
    const versionDifference = (left.versionAfter ?? -1) - (right.versionAfter ?? -1);
    return versionDifference || left.createdAt.localeCompare(right.createdAt);
  })) {
    for (const change of audit.changes) result.set(change.orderItemId, { audit, change });
  }
  return result;
}

function hasCompleteAuditContinuity(
  audits: OrderPriceAuditEvidence[],
  versionAfterPriceChange: number,
  currentVersion: number,
) {
  if (versionAfterPriceChange > currentVersion) return false;
  const auditedVersions = new Set(
    audits.flatMap((audit) => audit.versionAfter === null ? [] : [audit.versionAfter]),
  );
  for (let version = versionAfterPriceChange; version <= currentVersion; version += 1) {
    if (!auditedVersions.has(version)) return false;
  }
  return true;
}

function immutableHistory(order: AdminOrderRow) {
  return Boolean(
    order.invoice_id
    || IMMUTABLE_ORDER_STATUSES.has(String(order.status))
    || CONFIRMED_PAYMENT_STATUSES.has(String(order.payment_status)),
  );
}

export function classifyOrderPriceReviewV2(
  order: AdminOrderRow,
  evidence: OrderPriceReviewEvidence,
): OrderPriceReview {
  const invoiceConsistent = invoiceMatchesOrder(order, evidence.invoice);
  const reasons: string[] = [];
  const legitimateModeFallbackItemIds: string[] = [];
  const latestChanges = latestChangeByLine(evidence.audits);
  const adjustments: AuthorizedPriceAdjustment[] = [];
  let hasManualDifference = false;
  let hasUnexplainedDifference = false;

  if (invoiceConsistent === false) reasons.push("invoice_order_mismatch");

  for (const item of order.order_items) {
    const automaticPrice = automaticUnitPrice(item);
    const priceDiffers = !moneyMatches(item.unit_price, automaticPrice);
    const legitimateFallback = isLegitimateWholesaleFallback(order, item);
    const modeDiffers = item.applied_price_mode !== order.price_mode;

    if (legitimateFallback) legitimateModeFallbackItemIds.push(item.id);
    else if (modeDiffers) reasons.push(`unexplained_mode:${item.id}`);

    if (item.unit_cost_snapshot && item.unit_price + MONEY_TOLERANCE < item.unit_cost_snapshot) {
      reasons.push(`below_cost:${item.id}`);
    }

    if (!priceDiffers) continue;
    hasManualDifference = true;
    const latest = latestChanges.get(item.id);
    const authorized = Boolean(
      latest
      && AUTHORIZED_OVERRIDE_ROLES.has(latest.audit.actorRole)
      && latest.audit.versionAfter !== null
      && hasCompleteAuditContinuity(
        evidence.audits,
        latest.audit.versionAfter,
        order.commercial_terms_version,
      )
      && moneyMatches(latest.change.automaticUnitPrice, automaticPrice)
      && latest.change.previousUnitPrice > 0
      && moneyMatches(latest.change.finalUnitPrice, item.unit_price),
    );

    if (!authorized || !latest) {
      hasUnexplainedDifference = true;
      reasons.push(`unaudited_price:${item.id}`);
      continue;
    }

    adjustments.push({
      auditId: latest.audit.auditId,
      orderItemId: item.id,
      actorName: latest.audit.actorName,
      actorRole: latest.audit.actorRole,
      adjustedAt: latest.audit.createdAt,
      versionAfter: latest.audit.versionAfter,
      automaticUnitPrice: latest.change.automaticUnitPrice,
      previousUnitPrice: latest.change.previousUnitPrice,
      finalUnitPrice: latest.change.finalUnitPrice,
      note: latest.audit.note,
    });
  }

  if (reasons.some((reason) => (
    reason === "invoice_order_mismatch"
    || reason.startsWith("below_cost:")
    || reason.startsWith("unexplained_mode:")
  ))) {
    return { status: "action_required", reasons, invoiceConsistent, legitimateModeFallbackItemIds, adjustments };
  }

  if (hasManualDifference && !hasUnexplainedDifference) {
    return {
      status: "authorized_manual_override",
      reasons: ["authorized_manual_override"],
      invoiceConsistent,
      legitimateModeFallbackItemIds,
      adjustments,
    };
  }

  if (hasUnexplainedDifference) {
    if (immutableHistory(order) && order.commercial_terms_version === 0 && invoiceConsistent !== false) {
      return { status: "legacy_information", reasons, invoiceConsistent, legitimateModeFallbackItemIds, adjustments };
    }
    return { status: "action_required", reasons, invoiceConsistent, legitimateModeFallbackItemIds, adjustments };
  }

  if (immutableHistory(order)) {
    return {
      status: "legacy_information",
      reasons: ["immutable_consistent_history"],
      invoiceConsistent,
      legitimateModeFallbackItemIds,
      adjustments: [],
    };
  }

  return { status: "none", reasons: [], invoiceConsistent, legitimateModeFallbackItemIds, adjustments: [] };
}
