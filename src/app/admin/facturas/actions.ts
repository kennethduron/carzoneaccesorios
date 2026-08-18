"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
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
