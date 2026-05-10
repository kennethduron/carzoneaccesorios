"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export async function cancelInvoiceAction(invoiceId: string) {
  await requirePermission("invoices:manage");
  const supabase = await getSupabaseServerClient();

  const { error } = await supabase
    .from("invoices")
    .update({
      status: "anulada",
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);

  if (error) {
    return { ok: false, message: error.message };
  }

  revalidatePath("/admin/facturas");
  revalidatePath("/admin/reportes");
  return { ok: true, message: "Factura anulada correctamente." };
}
