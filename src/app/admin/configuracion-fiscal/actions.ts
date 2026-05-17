"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import {
  getAdminCompanySettings,
  saveAdminCompanySettings,
  type AdminCompanySettings,
} from "@/services/supabase/admin-commerce-settings.service";
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

export async function saveCommerceSettingsAction(input: AdminCompanySettings) {
  await requirePermission("settings:manage");

  if (input.cash_on_delivery_percentage > 100) {
    return { ok: false, message: "La comisión por pago al recibir no puede ser mayor a 100%." };
  }

  const invalidSocialUrl = validateSocialUrls(input);
  if (invalidSocialUrl) {
    return { ok: false, message: invalidSocialUrl };
  }

  if (!input.trade_name.trim()) {
    return { ok: false, message: "El nombre comercial es obligatorio." };
  }

  if (input.customer_service_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.customer_service_email.trim())) {
    return { ok: false, message: "El correo de servicio al cliente debe ser válido." };
  }

  const previousSettings = await getAdminCompanySettings();
  await saveAdminCompanySettings(input);
  const changes = commerceSettingsChanges(previousSettings, input);

  await writeAuditLog({
    tableName: "company_settings",
    action: "commerce.settings.updated",
    oldData: previousSettings,
    newData: {
      ...input,
      changes,
    },
  });

  revalidatePath("/admin/configuracion-fiscal");
  revalidatePath("/checkout");
  revalidatePath("/");
  revalidatePath("/contacto");
  revalidatePath("/politicas");
  revalidatePath("/contacto-servicio-cliente");

  return { ok: true, message: "Configuración comercial guardada correctamente." };
}

function validateOptionalUrl(label: string, value: string) {
  const cleanValue = value.trim();
  if (!cleanValue) {
    return null;
  }

  try {
    const url = new URL(cleanValue);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return `${label} debe iniciar con https:// o http://.`;
    }
  } catch {
    return `${label} debe ser una URL válida.`;
  }

  return null;
}

function validateSocialUrls(input: AdminCompanySettings) {
  return (
    validateOptionalUrl("Facebook", input.facebook_url) ??
    validateOptionalUrl("Instagram", input.instagram_url) ??
    validateOptionalUrl("WhatsApp", input.whatsapp_url) ??
    validateOptionalUrl("TikTok", input.tiktok_url) ??
    validateOptionalUrl("YouTube", input.youtube_url) ??
    validateOptionalUrl("Sitio web", input.website_url) ??
    validateOptionalUrl("WhatsApp de servicio al cliente", input.customer_service_whatsapp)
  );
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

function commerceSettingsChanges(previous: AdminCompanySettings, next: AdminCompanySettings) {
  const fields = Object.keys(next) as Array<keyof AdminCompanySettings>;

  return fields.reduce<Record<string, { from: string | number | boolean; to: string | number | boolean }>>((changes, field) => {
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
