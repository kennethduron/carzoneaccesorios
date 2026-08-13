"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { revalidateProductAvailability } from "@/lib/product-availability-cache";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { dispatchAccountingEvent } from "@/services/accounting/accounting-event-dispatcher";
import type { PurchasePaymentCondition, PurchaseStatus } from "@/types/purchases";

export type PurchaseConfirmationInput = {
  purchase_id: string;
  payment_condition: PurchasePaymentCondition;
  due_date?: string | null;
  initial_payment_amount?: number | string | null;
  payment_method?: "cash" | "bank_transfer" | "card_credit" | "card_debit" | null;
  payment_date?: string | null;
  payment_notes?: string | null;
  request_key: string;
};

export type PurchaseConfirmationResult = {
  purchase_id: string;
  purchase_status: PurchaseStatus;
  accounts_payable_id: string;
  accounts_payable_status: "pending" | "partial" | "paid" | "cancelled" | "overdue";
  total_amount: number;
  paid_amount: number;
  balance: number;
  due_date: string | null;
  supplier_payment_id: string | null;
  replayed: boolean;
};

type ActionResult = { ok: true; message: string; data?: PurchaseConfirmationResult } | { ok: false; message: string };

type PurchaseItemInput = {
  id?: string;
  product_id?: string | null;
  description: string;
  quantity: number | string;
  unit_cost: number | string;
  tax_amount?: number | string | null;
  discount_amount?: number | string | null;
};

export type PurchaseFormInput = {
  id?: string;
  supplier_id: string;
  purchase_number: string;
  purchase_date: string;
  shipping_amount?: number | string | null;
  currency?: string | null;
  notes?: string | null;
  items: PurchaseItemInput[];
};


export type PurchaseReturnFormInput = {
  purchase_id: string;
  return_number: string;
  return_date: string;
  amount: number | string;
  reason?: string | null;
};
function cleanText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}

function toMoney(value: unknown) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : NaN;
}

function purchaseErrorMessage(message: string) {
  if (message.includes("purchases_purchase_number_key")) {
    return "Ya existe una compra con ese número.";
  }

  if (message.includes("IDs de lineas duplicados")) {
    return "La solicitud contiene líneas duplicadas. Recarga la compra e intenta nuevamente.";
  }

  if (message.includes("Solo se pueden editar compras en borrador")) {
    return "Solo se pueden editar compras en borrador.";
  }

  if (message.includes("por debajo de sus unidades reservadas")) {
    return "La edición dejaría el inventario por debajo de las unidades reservadas.";
  }

  if (message.includes("proveedor seleccionado esta inactivo")) {
    return "El proveedor seleccionado está inactivo.";
  }

  return "No se pudo guardar la compra.";
}

function purchaseTransitionErrorMessage(message: string, fallback: string) {
  const purchaseApMessages: Record<string, string> = {
    PURCHASE_AP_AUTOMATION_REQUIRED: "La automatización de cuentas por pagar está activa. Recarga la página y confirma con la condición de pago.",
    PURCHASE_AP_AUTOMATION_DISABLED: "La automatización de cuentas por pagar está desactivada. Recarga la página.",
    PURCHASE_REQUEST_KEY_REQUIRED: "No se pudo identificar este intento de confirmación. Cierra el diálogo e intenta de nuevo.",
    PURCHASE_REQUEST_KEY_CONFLICT: "La clave de esta confirmación ya fue utilizada en otra compra.",
    PURCHASE_CONFIRMATION_FINGERPRINT_CONFLICT: "Los datos financieros cambiaron durante el reintento. Revisa la confirmación.",
    PURCHASE_ALREADY_CONFIRMED: "La compra ya fue confirmada por otra solicitud.",
    PURCHASE_REPLAY_PAYABLE_MISSING: "La compra fue confirmada, pero su cuenta por pagar requiere revisión.",
    PURCHASE_PAYMENT_CONDITION_INVALID: "Selecciona una condición de pago válida.",
    PURCHASE_CREDIT_PAYMENT_MUST_BE_ZERO: "Una compra al crédito no puede incluir pago inicial.",
    PURCHASE_PARTIAL_AMOUNT_INVALID: "El pago inicial debe ser mayor que cero y menor que el total de la compra.",
    PURCHASE_PAYMENT_METHOD_INVALID: "Selecciona un método de pago permitido.",
    PURCHASE_DUE_DATE_REQUIRED: "Indica la fecha de vencimiento para el saldo pendiente.",
    PURCHASE_SUPPLIER_INVALID: "El proveedor de la compra no está activo.",
    PURCHASE_MULTIPLE_ACTIVE_SUPPLIER_INVOICES: "La compra tiene más de una factura de proveedor activa y requiere revisión.",
    PURCHASE_SUPPLIER_INVOICE_INCONSISTENT: "La factura de proveedor no coincide con el proveedor, total o moneda de la compra.",
    PURCHASE_ACTIVE_PAYABLE_INCONSISTENT: "La cuenta por pagar existente no coincide con la compra y requiere revisión.",
    PURCHASE_PAYMENTS_MUST_BE_VOIDED_FIRST: "La compra tiene pagos aplicados. Anúlalos mediante el proceso controlado antes de cancelar.",
    PURCHASE_ACTIVE_SUPPLIER_INVOICE_BLOCKS_CANCEL: "La compra tiene una factura de proveedor activa y no puede cancelarse automáticamente.",
    PURCHASE_ACCOUNTING_REVERSAL_REQUIRED: "La obligación ya tiene contabilidad vinculada y requiere una reversión controlada.",
    PURCHASE_ACCOUNTING_SCOPE_REQUIRED: "La compra no pudo activar de forma segura su alcance contable. No se confirmó ningún cambio.",
    PURCHASE_ACCOUNTING_OBLIGATION_REQUIRED: "No se pudo asegurar la obligación contable de la compra. No se confirmó ningún cambio.",
    PURCHASE_ACCOUNTING_CANONICAL_CONFLICT: "Existe una obligación contable incompatible para esta compra. No se confirmó ningún cambio y se requiere revisión técnica.",
    PURCHASE_ACCOUNTING_LEGACY_CONFLICT: "Existe un borrador contable V1 competidor para esta compra. No se confirmó ningún cambio y se requiere revisión contable.",
    PURCHASE_MANUAL_PAYABLE_REVIEW_REQUIRED: "La compra tiene una cuenta por pagar manual y requiere revisión antes de cancelarse.",
    PURCHASE_NOT_AUTOMATED: "La compra pertenece al flujo anterior y se cancelará con el proceso compatible.",
    PURCHASE_ALREADY_CANCELLED: "La compra ya fue cancelada.",
  };
  const mapped = Object.entries(purchaseApMessages).find(([code]) => message.includes(code));
  if (mapped) return mapped[1];

  const knownMessages = [
    "La compra no existe.",
    "Solo se pueden confirmar compras en borrador.",
    "Agrega al menos una linea antes de confirmar.",
    "La compra ya fue cancelada.",
    "Esta compra ya no se puede cancelar.",
    "No se puede cancelar una compra con factura o cuenta por pagar activa.",
  ];
  const known = knownMessages.find((candidate) => message.includes(candidate));
  if (known) return known.replace("linea", "línea");
  if (message.includes("inventario") && message.includes("ya fue consumido")) {
    return "No se puede cancelar la compra porque parte de su inventario ya fue consumido.";
  }
  if (message.includes("unidades reservadas")) {
    return "No se puede cancelar la compra porque parte de su inventario está reservado.";
  }
  return fallback;
}

function buildPurchaseTotals(items: PurchaseItemInput[], shippingValue: unknown) {
  const normalizedItems = items.map((item) => {
    const description = cleanText(item.description);
    const quantity = toMoney(item.quantity);
    const unitCost = toMoney(item.unit_cost);
    const taxAmount = toMoney(item.tax_amount ?? 0);
    const discountAmount = toMoney(item.discount_amount ?? 0);

    if (!description) {
      throw new Error("Cada línea necesita descripción.");
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("La cantidad de cada línea debe ser mayor que cero.");
    }

    if (!Number.isFinite(unitCost) || unitCost < 0) {
      throw new Error("El costo unitario no puede ser negativo.");
    }

    if (!Number.isFinite(taxAmount) || taxAmount < 0 || !Number.isFinite(discountAmount) || discountAmount < 0) {
      throw new Error("Impuestos y descuentos no pueden ser negativos.");
    }

    const lineSubtotal = Math.round(quantity * unitCost * 100) / 100;
    const totalCost = Math.max(Math.round((lineSubtotal + taxAmount - discountAmount) * 100) / 100, 0);

    return {
      id: cleanText(item.id),
      product_id: cleanText(item.product_id),
      description,
      quantity,
      unit_cost: unitCost,
      tax_amount: taxAmount,
      discount_amount: discountAmount,
      total_cost: totalCost,
    };
  });

  const shippingAmount = toMoney(shippingValue ?? 0);
  if (!Number.isFinite(shippingAmount) || shippingAmount < 0) {
    throw new Error("El envío no puede ser negativo.");
  }

  const subtotal = Math.round(normalizedItems.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0) * 100) / 100;
  const taxAmount = Math.round(normalizedItems.reduce((sum, item) => sum + item.tax_amount, 0) * 100) / 100;
  const discountAmount = Math.round(normalizedItems.reduce((sum, item) => sum + item.discount_amount, 0) * 100) / 100;
  const total = Math.max(Math.round((subtotal + taxAmount + shippingAmount - discountAmount) * 100) / 100, 0);

  return { normalizedItems, subtotal, taxAmount, discountAmount, shippingAmount, total };
}

type PurchaseInventorySaveRow = {
  purchase_id: string;
  purchase_number: string;
  purchase_status: PurchaseStatus;
  purchase_total: number;
  was_created: boolean;
  affected_products: Array<{ id: string; slug: string | null; category_id: string | null }>;
};

type PurchaseTransitionRow = {
  purchase_id: string;
  purchase_number: string;
  purchase_status: PurchaseStatus;
};

type PurchaseCancellationRow = PurchaseTransitionRow & {
  affected_products: Array<{ id: string; slug: string | null; category_id: string | null }>;
};

export async function savePurchaseAction(input: PurchaseFormInput): Promise<ActionResult> {
  await requirePermission("purchases:manage");
  const supplierId = cleanText(input.supplier_id);
  const purchaseNumber = cleanText(input.purchase_number);
  const purchaseDate = cleanText(input.purchase_date);
  const currency = cleanText(input.currency) ?? "HNL";

  if (!supplierId) return { ok: false, message: "Selecciona un proveedor." };
  if (!purchaseNumber) return { ok: false, message: "El numero de compra es obligatorio." };
  if (!purchaseDate) return { ok: false, message: "La fecha de compra es obligatoria." };

  let totals: ReturnType<typeof buildPurchaseTotals>;
  try {
    totals = buildPurchaseTotals(input.items ?? [], input.shipping_amount);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Revisa las lineas de compra." };
  }

  if (totals.normalizedItems.length === 0) {
    return { ok: false, message: "Agrega al menos una linea a la compra." };
  }

  if (totals.normalizedItems.some((item) => item.product_id && !Number.isInteger(item.quantity))) {
    return { ok: false, message: "La cantidad de un producto de inventario debe ser un numero entero." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("save_purchase_with_inventory", {
    target_purchase_id: input.id ?? null,
    purchase_data: {
      supplier_id: supplierId,
      purchase_number: purchaseNumber,
      purchase_date: purchaseDate,
      subtotal: totals.subtotal,
      tax_amount: totals.taxAmount,
      discount_amount: totals.discountAmount,
      shipping_amount: totals.shippingAmount,
      total: totals.total,
      currency,
      notes: cleanText(input.notes),
    },
    items_data: totals.normalizedItems,
  });

  if (error) {
    return { ok: false, message: purchaseErrorMessage(error.message) };
  }

  const row = (Array.isArray(data) ? data[0] : data) as PurchaseInventorySaveRow | null;
  if (!row?.purchase_id) {
    return { ok: false, message: "No se pudo confirmar la compra guardada." };
  }

  revalidateProductAvailability({
    adminPaths: ["/admin/compras", "/admin/inventario", "/admin/productos", "/admin/reportes", "/admin/contabilidad"],
    productSlugs: (row.affected_products ?? []).map((product) => product.slug),
  });

  return {
    ok: true,
    message: row.was_created
      ? "Compra registrada correctamente. El inventario fue actualizado."
      : "Compra actualizada correctamente. El inventario fue ajustado.",
  };
}

export async function confirmPurchaseAction(input: string | PurchaseConfirmationInput): Promise<ActionResult> {
  const profile = await requirePermission("purchases:manage");
  const supabase = await getSupabaseServerClient();

  const { data: featureEnabled, error: featureError } = await supabase.rpc("purchase_ap_automation_enabled_v1");
  if (featureError) {
    return { ok: false, message: "No se pudo verificar la configuración de confirmación." };
  }

  const purchaseId = typeof input === "string" ? cleanText(input) : cleanText(input.purchase_id);
  if (!purchaseId) return { ok: false, message: "La compra no es válida." };

  if (!featureEnabled) {
    const { data, error } = await supabase.rpc("confirm_purchase_locked", { target_purchase_id: purchaseId });
    if (error) {
      return { ok: false, message: purchaseTransitionErrorMessage(error.message, "No se pudo confirmar la compra.") };
    }

    const row = (Array.isArray(data) ? data[0] : data) as PurchaseTransitionRow | null;
    if (!row?.purchase_id) return { ok: false, message: "No se pudo confirmar la compra." };

    await dispatchAccountingEvent({ sourceType: "purchase", sourceId: purchaseId, eventPurpose: "purchase_confirmed", triggeredBy: profile.id, route: "/admin/compras" });
    revalidatePath("/admin/compras");
    return { ok: true, message: "Compra confirmada." };
  }

  if (typeof input === "string") {
    return { ok: false, message: "Recarga la página para seleccionar la condición de pago antes de confirmar." };
  }

  const initialPaymentAmount = input.initial_payment_amount === null || input.initial_payment_amount === undefined || input.initial_payment_amount === ""
    ? null
    : toMoney(input.initial_payment_amount);
  if (initialPaymentAmount !== null && !Number.isFinite(initialPaymentAmount)) {
    return { ok: false, message: "El pago inicial no es válido." };
  }

  const { data, error } = await supabase.rpc("confirm_purchase_with_payable_v1", {
    target_purchase_id: purchaseId,
    p_payment_condition: input.payment_condition,
    p_due_date: cleanText(input.due_date),
    p_initial_payment_amount: initialPaymentAmount,
    p_payment_method: cleanText(input.payment_method),
    p_payment_date: cleanText(input.payment_date),
    p_payment_notes: cleanText(input.payment_notes),
    p_request_key: cleanText(input.request_key),
  });
  if (error) {
    return { ok: false, message: purchaseTransitionErrorMessage(error.message, "No se pudo confirmar la compra.") };
  }

  const row = (Array.isArray(data) ? data[0] : data) as PurchaseConfirmationResult | null;
  if (!row?.purchase_id) return { ok: false, message: "No se pudo confirmar la compra." };

  revalidatePath("/admin/compras");
  revalidatePath("/admin/cuentas-por-pagar");
  return {
    ok: true,
    message: row.replayed ? "Confirmación recuperada sin duplicar movimientos." : "Compra confirmada y cuenta por pagar registrada.",
    data: {
      ...row,
      total_amount: Number(row.total_amount),
      paid_amount: Number(row.paid_amount),
      balance: Number(row.balance),
    },
  };
}

export async function cancelPurchaseAction(purchaseId: string, requestKey: string): Promise<ActionResult> {
  const profile = await requirePermission("purchases:manage");
  const supabase = await getSupabaseServerClient();
  let { data, error } = await supabase.rpc("cancel_purchase_with_payable_v1", {
    target_purchase_id: purchaseId,
    p_request_key: requestKey,
  });
  if (error?.message.includes("PURCHASE_NOT_AUTOMATED")) {
    const legacy = await supabase.rpc("cancel_purchase_with_inventory", { target_purchase_id: purchaseId });
    data = legacy.data;
    error = legacy.error;
    if (!error) {
      await dispatchAccountingEvent({ sourceType: "purchase", sourceId: purchaseId, eventPurpose: "purchase_cancelled", triggeredBy: profile.id, route: "/admin/compras" });
    }
  }
  if (error) {
    return { ok: false, message: purchaseTransitionErrorMessage(error.message, "No se pudo cancelar la compra.") };
  }

  const row = (Array.isArray(data) ? data[0] : data) as PurchaseCancellationRow | null;
  if (!row?.purchase_id) return { ok: false, message: "No se pudo cancelar la compra." };

  revalidateProductAvailability({
    adminPaths: ["/admin/compras", "/admin/inventario", "/admin/productos", "/admin/reportes", "/admin/contabilidad"],
    productSlugs: (row.affected_products ?? []).map((product) => product.slug),
  });
  return { ok: true, message: "Compra cancelada." };
}

export async function registerPurchaseReturnAction(input: PurchaseReturnFormInput): Promise<ActionResult> {
  const profile = await requirePermission("purchases:manage");
  const purchaseId = cleanText(input.purchase_id);
  const returnNumber = cleanText(input.return_number);
  const returnDate = cleanText(input.return_date);
  const amount = toMoney(input.amount);

  if (!purchaseId) return { ok: false, message: "Selecciona una compra." };
  if (!returnNumber) return { ok: false, message: "El número de devolución es obligatorio." };
  if (!returnDate) return { ok: false, message: "La fecha de devolución es obligatoria." };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: "El monto de la devolución debe ser mayor que cero." };

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("register_purchase_return", {
    target_purchase_id: purchaseId,
    purchase_return_number: returnNumber,
    purchase_return_date: returnDate,
    return_amount: amount,
    return_reason: cleanText(input.reason),
  });

  if (error) {
    return { ok: false, message: error.message || "No se pudo registrar la devolución." };
  }

  const row = Array.isArray(data) ? data[0] : data;
  await writeAuditLog({ tableName: "purchase_returns", recordId: row?.purchase_return_id ?? null, action: "purchase_returns.create", newData: { purchase_id: purchaseId, amount } });
  if (row?.purchase_return_id) {
    await dispatchAccountingEvent({ sourceType: "purchase_return", sourceId: row.purchase_return_id, eventPurpose: "purchase_return", triggeredBy: profile.id, route: "/admin/compras" });
  }
  revalidatePath("/admin/compras");
  revalidatePath("/admin/cuentas-por-pagar");
  return { ok: true, message: "Devolución a proveedor registrada." };
}
