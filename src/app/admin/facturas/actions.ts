"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { getSessionProfile, requirePermission } from "@/lib/auth/session";
import {
  autoCentroExt100Incident,
  getPendingAutoCentroExt100Recovery,
  isCommercialReversalRecoveryRole,
} from "@/lib/incidents/auto-centro-ext100-commercial-reversal";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getAdminInvoiceDetail } from "@/services/supabase/admin-invoices.service";

function normalizeOptionalRtn(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const digits = trimmed.replace(/[\s-]/g, "");
  if (!/^\d{14}$/.test(digits)) {
    return { error: "El RTN debe contener 14 dígitos." };
  }

  return digits;
}

function canViewAccountingTraceability(profile: Awaited<ReturnType<typeof requirePermission>>) {
  return ["technical_owner", "business_owner", "admin", "contadora"].includes(profile.role)
    || hasEffectivePermission(profile.role, profile.permissions, "accounting:read", profile.email);
}

async function getAuditRequestMetadata() {
  const headerStore = await headers();
  const forwardedFor = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ipAddress = forwardedFor || headerStore.get("x-real-ip") || headerStore.get("cf-connecting-ip");

  return {
    ipAddress: ipAddress && /^[0-9a-fA-F:.]+$/.test(ipAddress) ? ipAddress : null,
    userAgent: headerStore.get("user-agent"),
  };
}

export async function getInvoiceDetailAction(invoiceId: string) {
  const profile = await requirePermission("invoices:read");
  const detail = await getAdminInvoiceDetail(invoiceId, {
    includeAccountingTraceability: canViewAccountingTraceability(profile),
  });

  if (!detail) {
    return { ok: false, message: "Factura no encontrada.", invoice: null };
  }

  return { ok: true, message: "", invoice: detail };
}

export async function cancelInvoiceAction(invoiceId: string, cancellationReason: string) {
  await requirePermission("invoices:manage");
  const reason = cancellationReason.trim();

  if (reason.length < 8) {
    return { ok: false, message: "El motivo de anulación es obligatorio." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("cancel_sale_invoice_v1", {
    p_invoice_id: invoiceId,
    p_reason: reason,
    p_recovery_mode: false,
    p_recovery_expected: null,
  });

  if (error) {
    const messages: Record<string, string> = {
      SALE_REVERSAL_PERMISSION_DENIED: "No tienes todos los permisos requeridos para revertir la venta.",
      SALE_REVERSAL_INVOICE_NOT_ELIGIBLE: "La factura no está en un estado permitido para anulación.",
      SALE_REVERSAL_REQUIRES_PAYMENT_REFUND: "La venta tiene un pago aplicado. Debe completarse primero el proceso autorizado de devolución del dinero.",
      SALE_REVERSAL_REQUIRES_RECEIVABLE_REFUND: "La cuenta por cobrar tiene pagos o un saldo parcial. Debe completarse primero el proceso autorizado de devolución.",
      SALE_REVERSAL_UNLINKED_RETURN_EXISTS: "Ya existe una devolución no vinculada que requiere revisión antes de anular la venta.",
      SALE_REVERSAL_ORIGINAL_MOVEMENTS_MISSING: "No se encontraron los movimientos originales necesarios para devolver el inventario.",
      SALE_REVERSAL_MOVEMENT_ALREADY_REVERSED: "El inventario de esta venta ya fue revertido.",
      SALE_REVERSAL_ORDER_ALREADY_CANCELLED: "La venta ya está cancelada o revertida.",
    };
    return { ok: false, message: messages[error.message] ?? "No se pudo anular y revertir la venta de forma completa. Ningún cambio fue aplicado." };
  }

  revalidatePath("/admin/facturas");
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/reportes");
  revalidatePath("/admin/crm");
  revalidatePath("/admin/contabilidad");
  revalidatePath("/facturas");
  revalidatePath("/mis-pedidos");
  revalidatePath("/cuenta");
  revalidatePath("/rastreo");
  const status = (data as { status?: string } | null)?.status;
  return {
    ok: true,
    message: status === "ALREADY_REVERSED"
      ? "La factura y la venta ya estaban revertidas; no se duplicó ningún efecto."
      : "Factura anulada y venta revertida correctamente. El inventario, el pedido, la cuenta por cobrar y la contabilidad quedaron reconciliados.",
  };
}

const incidentRecoveryConfirmation = "CONFIRM_AUTO_CENTRO_EXT100_COMMERCIAL_REVERSAL";

function commercialReversalErrorMessage(code: string | undefined) {
  const messages: Record<string, string> = {
    SALE_REVERSAL_PERMISSION_DENIED: "Tu sesión no tiene todos los permisos requeridos para completar esta reversión.",
    SALE_REVERSAL_RECOVERY_PERMISSION_DENIED: "Tu rol no está autorizado para completar esta reversión histórica.",
    SALE_REVERSAL_RECOVERY_INVOICE_MISMATCH: "La factura o el pedido cambiaron desde la auditoría. La reversión fue denegada sin aplicar cambios.",
    SALE_REVERSAL_RECOVERY_INVENTORY_MISMATCH: "El inventario ya no coincide con la evidencia auditada. La reversión fue denegada sin aplicar cambios.",
    SALE_REVERSAL_RECOVERY_LATER_MOVEMENT_FOUND: "Existe un movimiento posterior de inventario. La reversión fue denegada sin aplicar cambios.",
    SALE_REVERSAL_RECOVERY_PAYMENT_FOUND: "Apareció un pago vinculado. La reversión requiere revisión y no aplicó cambios.",
    SALE_REVERSAL_RECOVERY_RECEIVABLE_MISMATCH: "La cuenta por cobrar cambió desde la auditoría. La reversión fue denegada sin aplicar cambios.",
    SALE_REVERSAL_RECOVERY_ACCOUNTING_MISMATCH: "La contabilidad cambió desde la auditoría. La reversión fue denegada sin aplicar cambios.",
    SALE_REVERSAL_MOVEMENT_ALREADY_REVERSED: "El movimiento de inventario ya fue revertido.",
    SALE_REVERSAL_ORDER_ALREADY_CANCELLED: "La venta ya fue revertida o cancelada.",
  };
  return messages[code ?? ""] ?? "No se pudo completar la reversión comercial. Ningún cambio parcial fue aplicado.";
}

function revalidateCommercialReversalPaths() {
  for (const path of [
    "/admin/facturas",
    "/admin/pedidos",
    "/admin/productos",
    "/admin/reportes",
    "/admin/crm",
    "/admin/contabilidad",
    "/facturas",
    "/mis-pedidos",
    "/cuenta",
    "/rastreo",
  ]) {
    revalidatePath(path);
  }
}

export async function completeAnnulledInvoiceCommercialReversalAction(
  invoiceId: string,
  confirmation: string,
) {
  const profile = await getSessionProfile();
  if (!profile || !isCommercialReversalRecoveryRole(profile.role)) {
    return { ok: false, message: "No tienes autorización para completar esta reversión histórica." };
  }

  if (invoiceId !== autoCentroExt100Incident.invoiceId || confirmation !== incidentRecoveryConfirmation) {
    return { ok: false, message: "La solicitud no coincide con el incidente autorizado." };
  }

  const pending = await getPendingAutoCentroExt100Recovery(profile.role);
  if (!pending || pending.invoiceId !== invoiceId) {
    return { ok: false, message: "Las condiciones auditadas cambiaron o la reversión ya fue completada. No se aplicaron cambios." };
  }

  const incident = autoCentroExt100Incident;
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("cancel_sale_invoice_v1", {
    p_invoice_id: incident.invoiceId,
    p_reason: incident.cancellationReason,
    p_recovery_mode: true,
    p_recovery_expected: {
      order_id: incident.orderId,
      order_status: "entregado",
      customer_id: incident.customerId,
      product_id: incident.productId,
      original_movement_id: incident.movementId,
      original_movement_count: 1,
      quantity: incident.quantity,
      current_stock: incident.stock,
      receivable_id: incident.receivableId,
      receivable_balance: incident.receivableBalance,
      cancellation_reason: incident.cancellationReason,
    },
  });

  if (error) {
    return { ok: false, message: commercialReversalErrorMessage(error.message) };
  }

  const result = data as {
    status?: string;
    invoice_status?: string;
    order_status?: string;
    reversal_movement_ids?: string[];
    receivable_effect?: string;
    accounting_effects?: Array<{ event_purpose?: string; status?: string }>;
  } | null;

  const [product, invoice, order, receivable, inverseMovements, reversalAudit] = await Promise.all([
    supabase.from("products").select("stock").eq("id", incident.productId).maybeSingle(),
    supabase.from("invoices").select("status").eq("id", incident.invoiceId).maybeSingle(),
    supabase.from("orders").select("status,commercial_reversal_invoice_id").eq("id", incident.orderId).maybeSingle(),
    supabase.from("accounts_receivable").select("status,balance_due").eq("id", incident.receivableId).maybeSingle(),
    supabase.from("inventory_movements")
      .select("id,quantity,reversal_of_movement_id")
      .eq("reversal_of_movement_id", incident.movementId),
    supabase.from("invoice_commercial_reversals")
      .select("id,actor_id,mode,reversal_movement_ids,receivable_effect,accounting_effects")
      .eq("invoice_id", incident.invoiceId).maybeSingle(),
  ]);

  const verificationFailed = [product, invoice, order, receivable, inverseMovements, reversalAudit]
    .some((query) => query.error);
  const inverse = inverseMovements.data ?? [];
  const expectedAccountingPurposes = new Set(["sale_recognized", "inventory_cogs"]);
  const accountingEffectsVerified = (effects: Array<{ event_purpose?: string; status?: string }>) =>
    effects.length === 2
      && effects.every((effect) => effect.status === "cancelled")
      && new Set(effects.map((effect) => effect.event_purpose)).size === 2
      && effects.every((effect) => expectedAccountingPurposes.has(effect.event_purpose ?? ""));
  const storedAccountingEffects = Array.isArray(reversalAudit.data?.accounting_effects)
    ? reversalAudit.data.accounting_effects as Array<{ event_purpose?: string; status?: string }>
    : [];
  const resultAccountingEffects = result?.accounting_effects ?? [];
  const verified = !verificationFailed
    && product.data?.stock === 4
    && ["anulada", "cancelled"].includes(invoice.data?.status ?? "")
    && ["cancelado", "cancelled"].includes(order.data?.status ?? "")
    && order.data?.commercial_reversal_invoice_id === incident.invoiceId
    && receivable.data?.status === "cancelled"
    && Number(receivable.data?.balance_due) === 0
    && inverse.length === 1
    && inverse[0]?.quantity === 1
    && inverse[0]?.reversal_of_movement_id === incident.movementId
    && reversalAudit.data?.actor_id === profile.id
    && reversalAudit.data?.mode === "incident_repair"
    && (reversalAudit.data?.reversal_movement_ids?.length ?? 0) === 1
    && reversalAudit.data?.receivable_effect === "cancelled_unpaid"
    && accountingEffectsVerified(storedAccountingEffects)
    && ["REVERSED", "ALREADY_REVERSED"].includes(result?.status ?? "")
    && result?.invoice_status === "anulada"
    && result?.order_status === "cancelado"
    && result?.receivable_effect === "cancelled_unpaid"
    && (result?.reversal_movement_ids?.length ?? 0) === 1
    && accountingEffectsVerified(resultAccountingEffects);

  revalidateCommercialReversalPaths();
  if (!verified) {
    return {
      ok: false,
      message: "La transacción terminó, pero la verificación canónica no pudo confirmarse por completo. No repitas la acción y solicita revisión técnica.",
    };
  }

  return {
    ok: true,
    message: "Reversión comercial completada correctamente.",
    evidence: {
      stock: 4,
      inverseMovementCount: 1,
      invoiceStatus: "anulada",
      orderStatus: "cancelado",
      receivableCollectible: false,
      accountingCompensated: true,
      auditRecorded: true,
    },
  };
}

export async function updateInvoiceCustomerDataAction(input: {
  invoiceId: string;
  customerName: string;
  customerRtn: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress: string;
  correctionReason: string;
}) {
  await requirePermission("invoices:correct");
  const customerName = input.customerName.trim();
  const customerPhone = input.customerPhone.trim();
  const customerEmail = input.customerEmail.trim().toLowerCase();
  const customerAddress = input.customerAddress.trim();
  const correctionReason = input.correctionReason.trim();
  const customerRtn = normalizeOptionalRtn(input.customerRtn);

  if (!customerName) {
    return { ok: false, message: "El nombre del cliente es obligatorio." };
  }

  if (typeof customerRtn === "object" && customerRtn?.error) {
    return { ok: false, message: customerRtn.error };
  }

  if (correctionReason.length < 10) {
    return { ok: false, message: "El motivo de corrección es obligatorio y debe tener al menos 10 caracteres." };
  }

  const supabase = await getSupabaseServerClient();
  const auditMetadata = await getAuditRequestMetadata();
  const { error } = await supabase.rpc("update_invoice_customer_data", {
    target_invoice_id: input.invoiceId,
    corrected_customer_name: customerName,
    corrected_customer_rtn: customerRtn,
    corrected_customer_phone: customerPhone || null,
    corrected_customer_email: customerEmail || null,
    corrected_customer_address: customerAddress || null,
    correction_reason: correctionReason,
    actor_ip: auditMetadata.ipAddress,
    actor_user_agent: auditMetadata.userAgent,
  });

  if (error) {
    return { ok: false, message: error.message || "No se pudieron corregir los datos de la factura." };
  }

  revalidatePath("/admin/facturas");
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/reportes");
  revalidatePath("/admin/crm");
  revalidatePath("/admin/contabilidad");
  revalidatePath("/facturas");
  revalidatePath("/cuenta");
  revalidatePath("/mis-pedidos");

  return { ok: true, message: "Datos del cliente corregidos. Puedes reimprimir la factura sin cambiar el número fiscal." };
}

export async function logInvoiceReprintAction(invoiceId: string) {
  await requirePermission("invoices:create");
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("log_invoice_reprint", {
    target_invoice_id: invoiceId,
  });

  if (error) {
    return { ok: false, message: error.message || "No se pudo registrar la reimpresion fiscal." };
  }

  revalidatePath("/admin/facturas");
  revalidatePath("/admin/seguridad");
  return { ok: true, message: "Reimpresión fiscal registrada en auditoría." };
}
