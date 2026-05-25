"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getAdminInvoiceDetail } from "@/services/supabase/admin-invoices.service";

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
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("cancel_fiscal_invoice", {
    target_invoice_id: invoiceId,
    cancellation_reason: cancellationReason,
  });

  if (error) {
    return { ok: false, message: error.message };
  }

  revalidatePath("/admin/facturas");
  revalidatePath("/admin/reportes");
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
  await requirePermission("invoices:create");
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("update_invoice_customer_data", {
    target_invoice_id: input.invoiceId,
    corrected_customer_name: input.customerName,
    corrected_customer_rtn: input.customerRtn || null,
    corrected_customer_phone: input.customerPhone || null,
    corrected_customer_email: input.customerEmail || null,
    corrected_customer_address: input.customerAddress || null,
    correction_reason: input.correctionReason,
  });

  if (error) {
    return { ok: false, message: error.message || "No se pudieron corregir los datos de la factura." };
  }

  revalidatePath("/admin/facturas");
  revalidatePath("/admin/pedidos");
  revalidatePath("/admin/reportes");

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
