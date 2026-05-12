"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getFiscalSettings, saveFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import {
  getNotificationSettings,
  saveNotificationSettings,
} from "@/services/supabase/admin-notification-settings.service";
import type { FiscalSettings } from "@/types/fiscal";
import type { NotificationSettings } from "@/types/notifications";

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

function notificationSettingsChanges(previous: NotificationSettings, next: NotificationSettings) {
  const fields: Array<keyof NotificationSettings> = [
    "notification_emails",
    "notify_new_orders",
    "notify_payment_confirmed",
    "notify_wholesale_requests",
  ];

  return fields.reduce<Record<string, { from: string | boolean; to: string | boolean }>>((changes, field) => {
    if (previous[field] !== next[field]) {
      changes[field] = {
        from: previous[field],
        to: next[field],
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

export async function saveNotificationSettingsAction(input: NotificationSettings) {
  await requirePermission("settings:manage");

  const previousSettings = await getNotificationSettings();
  await saveNotificationSettings(input);
  const changes = notificationSettingsChanges(previousSettings, input);

  await writeAuditLog({
    tableName: "company_settings",
    action: "notifications.settings.updated",
    oldData: previousSettings,
    newData: {
      ...input,
      changes,
    },
  });

  revalidatePath("/admin/configuracion-fiscal");

  return { ok: true, message: "Configuración de notificaciones guardada correctamente." };
}
