"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { saveFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import type { FiscalSettings } from "@/types/fiscal";

export async function saveFiscalSettingsAction(input: FiscalSettings) {
  await requirePermission("settings:manage");

  if (!input.legal_name.trim()) {
    return { ok: false, message: "El nombre legal de la empresa es obligatorio." };
  }

  await saveFiscalSettings(input);
  revalidatePath("/admin/configuracion-fiscal");
  revalidatePath("/admin/facturas");
  revalidatePath("/admin/reportes");

  return { ok: true, message: "Configuración fiscal guardada correctamente." };
}
