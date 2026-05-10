"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getFiscalSettings, saveFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import type { FiscalSettings } from "@/types/fiscal";

function fiscalSettingsChanges(previous: FiscalSettings, next: FiscalSettings) {
  const fields: Array<keyof FiscalSettings> = [
    "legal_name",
    "rtn",
    "cai",
    "invoice_range_start",
    "invoice_range_end",
    "current_invoice_number",
    "emission_deadline",
    "fiscal_address",
    "phone",
    "email",
    "logo_url",
  ];

  return fields.reduce<Record<string, { from: string | null; to: string | null }>>((changes, field) => {
    const previousValue = previous[field] ?? null;
    const nextValue = next[field] ?? null;

    if (previousValue !== nextValue) {
      changes[field] = {
        from: previousValue,
        to: nextValue,
      };
    }

    return changes;
  }, {});
}

export async function saveFiscalSettingsAction(input: FiscalSettings) {
  await requirePermission("settings:manage");

  if (!input.legal_name.trim()) {
    return { ok: false, message: "El nombre legal de la empresa es obligatorio." };
  }

  const previousSettings = await getFiscalSettings();
  await saveFiscalSettings(input);
  const changes = fiscalSettingsChanges(previousSettings, input);

  await writeAuditLog({
    tableName: "fiscal_settings",
    action: "fiscal.settings.updated",
    oldData: previousSettings,
    newData: {
      ...input,
      changes,
    },
  });

  revalidatePath("/admin/configuracion-fiscal");
  revalidatePath("/admin/facturas");
  revalidatePath("/admin/reportes");

  return { ok: true, message: "Configuración fiscal guardada correctamente." };
}
