"use server";

import { revalidatePath } from "next/cache";
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
    return { error: "El RTN debe tener 14 digitos. Puedes dejarlo vacio si corresponde." };
  }

  return digits;
}

export async function getInvoiceDetailAction(invoiceId: string) {
  await requirePermission("invoices:read");
  const detail = await getAdminInvoiceDetail(invoiceId);

  if (!detail) {
    return { ok: false, message: "Factura no encontrada.", invoice: null };
  }

  return { ok: true, message: "", invoice: detail };
}

export async function cancelInvoiceAction(invoiceId: string, cancellationReason: string) {
  await requirePermission("invoices:manage");
  const reason = cancellationReason.trim();

  if (reason.length < 8) {
    return { ok: false, message: "El motivo de anulacion es obligatorio." };
  }

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("cancel_fiscal_invoice", {
    target_invoice_id: invoiceId,
    cancellation_reason: reason,
  });

  if (error) {
    return { ok: false, message: error.message };
  }

  revalidatePath("/admin/facturas");
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/reportes");
  revalidatePath("/admin/crm");
  revalidatePath("/facturas");
  revalidatePath("/mis-pedidos");
  revalidatePath("/cuenta");
  revalidatePath("/rastreo");
  return { ok: true, message: "Factura anulada correctamente." };
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

  if (correctionReason.length < 8) {
    return { ok: false, message: "El motivo de correccion es obligatorio." };
  }

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("update_invoice_customer_data", {
    target_invoice_id: input.invoiceId,
    corrected_customer_name: customerName,
    corrected_customer_rtn: customerRtn,
    corrected_customer_phone: customerPhone || null,
    corrected_customer_email: customerEmail || null,
    corrected_customer_address: customerAddress || null,
    correction_reason: correctionReason,
  });

  if (error) {
    return { ok: false, message: error.message || "No se pudieron corregir los datos de la factura." };
  }

  revalidatePath("/admin/facturas");
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/reportes");
  revalidatePath("/admin/crm");
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
  return { ok: true, message: "Reimpresion fiscal registrada en auditoria." };
}
