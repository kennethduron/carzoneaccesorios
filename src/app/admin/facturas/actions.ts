"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function cancelInvoiceAction(invoiceId: string) {
  await requirePermission("invoices:manage");
  const supabase = await getSupabaseServerClient();
  const { data: previousInvoice, error: previousInvoiceError } = await supabase
    .from("invoices")
    .select("id, invoice_number, order_id, status, cancelled_at, total, tax, cai, rtn")
    .eq("id", invoiceId)
    .single<{
      id: string;
      invoice_number: string;
      order_id: string;
      status: string;
      cancelled_at: string | null;
      total: number;
      tax: number;
      cai: string | null;
      rtn: string | null;
    }>();

  if (previousInvoiceError) {
    return { ok: false, message: previousInvoiceError.message };
  }

  const cancelledAt = new Date().toISOString();

  const { error } = await supabase
    .from("invoices")
    .update({
      status: "anulada",
      cancelled_at: cancelledAt,
      updated_at: cancelledAt,
    })
    .eq("id", invoiceId);

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "invoices",
    recordId: invoiceId,
    action: "fiscal.invoice.cancelled",
    oldData: {
      invoice_id: previousInvoice.id,
      invoice_number: previousInvoice.invoice_number,
      order_id: previousInvoice.order_id,
      status: previousInvoice.status,
      cancelled_at: previousInvoice.cancelled_at,
      total: previousInvoice.total,
      tax: previousInvoice.tax,
      cai: previousInvoice.cai,
      rtn: previousInvoice.rtn,
    },
    newData: {
      invoice_id: previousInvoice.id,
      invoice_number: previousInvoice.invoice_number,
      order_id: previousInvoice.order_id,
      status: "anulada",
      cancelled_at: cancelledAt,
      changes: {
        status: { from: previousInvoice.status, to: "anulada" },
        cancelled_at: { from: previousInvoice.cancelled_at, to: cancelledAt },
      },
    },
  });

  revalidatePath("/admin/facturas");
  revalidatePath("/admin/reportes");
  return { ok: true, message: "Factura anulada correctamente." };
}
