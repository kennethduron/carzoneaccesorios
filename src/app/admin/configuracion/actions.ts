"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { getSessionProfile } from "@/lib/auth/session";
import { canRoleReceiveNotificationType, isAccountantNotificationType } from "@/lib/notifications/accountant-scope";
import {
  getAdminBusinessSettings,
  saveAdminBusinessSettings,
  sanitizeBusinessSettings,
} from "@/services/supabase/admin-business-settings.service";
import {
  getAdminNotificationPreferenceById,
  getAdminNotificationPreferenceByType,
  saveAdminNotificationUserPreference,
  saveAdminNotificationPreference,
} from "@/services/supabase/admin-notification-preferences.service";
import type { AppRole } from "@/types/auth";
import type { NotificationPreferenceUpdate, NotificationUserPreferenceUpdate } from "@/types/notifications";
import type { BusinessSettings } from "@/types/settings";

const allowedRoles: AppRole[] = ["business_owner", "admin", "technical_owner"];

function hasBusinessSettingsAccess(role: AppRole) {
  return allowedRoles.includes(role);
}

function buildChanges(previous: BusinessSettings, next: BusinessSettings) {
  return (Object.keys(next) as Array<keyof BusinessSettings>).reduce<Record<string, { from: unknown; to: unknown }>>(
    (changes, field) => {
      const previousValue = previous[field];
      const nextValue = next[field];
      if (JSON.stringify(previousValue) !== JSON.stringify(nextValue)) {
        changes[field] = {
          from: previousValue,
          to: nextValue,
        };
      }

      return changes;
    },
    {},
  );
}

function validateEmailList(value: string) {
  const emails = value
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);

  const invalid = emails.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  return invalid ? `Correo inválido: ${invalid}` : null;
}

function validateUrl(label: string, value: string) {
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

export async function saveBusinessSettingsAction(input: BusinessSettings) {
  const profile = await getSessionProfile();
  if (!profile || !hasBusinessSettingsAccess(profile.role)) {
    return { ok: false, message: "No tienes autorización para cambiar configuración empresarial." };
  }

  const sanitized = {
    ...sanitizeBusinessSettings(input),
    require_bank_reference: true,
    transfer_receipt_requirement: "optional" as const,
    stock_reservations_enabled: true,
  };
  const emailError = validateEmailList(sanitized.notification_emails);
  if (emailError) {
    return { ok: false, message: emailError };
  }

  const invalidUrl =
    validateUrl("Facebook", sanitized.facebook_url) ??
    validateUrl("Instagram", sanitized.instagram_url) ??
    validateUrl("WhatsApp", sanitized.whatsapp_url) ??
    validateUrl("TikTok", sanitized.tiktok_url) ??
    validateUrl("YouTube", sanitized.youtube_url) ??
    validateUrl("Sitio web", sanitized.website_url) ??
    validateUrl("WhatsApp de servicio al cliente", sanitized.customer_service_whatsapp);
  if (invalidUrl) {
    return { ok: false, message: invalidUrl };
  }

  if (!sanitized.allow_bank_transfer && !sanitized.allow_cash_on_delivery && sanitized.bac_card_status === "hidden") {
    return { ok: false, message: "Debe quedar al menos un método de pago disponible." };
  }

  const previous = await getAdminBusinessSettings();
  const saved = await saveAdminBusinessSettings(sanitized);
  const changes = buildChanges(previous, saved);

  if (Object.keys(changes).length > 0) {
    await writeAuditLog({
      tableName: "company_settings",
      action: "business_settings.updated",
      oldData: { changed_by: profile.id, changes: Object.fromEntries(Object.entries(changes).map(([field, value]) => [field, value.from])) },
      newData: { changed_by: profile.id, changes: Object.fromEntries(Object.entries(changes).map(([field, value]) => [field, value.to])) },
    });
  }

  revalidatePath("/admin");
  revalidatePath("/admin/configuracion");
  revalidatePath("/admin/configuracion-fiscal");
  revalidatePath("/admin/revision-bac");
  revalidatePath("/checkout");
  revalidatePath("/catalogo");
  revalidatePath("/");

  return {
    ok: true,
    message:
      Object.keys(changes).length > 0
        ? "Configuración empresarial guardada correctamente."
        : "No había cambios pendientes.",
  };
}

export async function saveNotificationPreferenceAction(input: NotificationPreferenceUpdate) {
  const profile = await getSessionProfile();
  if (!profile || !hasBusinessSettingsAccess(profile.role)) {
    return { ok: false, message: "No tienes autorización para cambiar preferencias de notificación." };
  }

  const existing = await getAdminNotificationPreferenceById(input.id);

  if (!existing) {
    return { ok: false, message: "Preferencia de notificación no encontrada." };
  }

  const allowedRoles: AppRole[] = ["technical_owner", "business_owner", "admin", "contadora", "bodega", "vendedor", "soporte"];
  const destinationRoles = input.destination_roles.filter(
    (role): role is AppRole =>
      allowedRoles.includes(role as AppRole) && canRoleReceiveNotificationType(role as AppRole, existing.notification_type),
  );

  if (existing.technical_only && profile.role !== "technical_owner") {
    return { ok: false, message: "Solo technical_owner puede gestionar notificaciones técnicas." };
  }

  const saved = await saveAdminNotificationPreference({
    ...input,
    destination_roles: destinationRoles,
  });

  await writeAuditLog({
    tableName: "notification_preferences",
    recordId: saved.id,
    action: "notification_preference.updated",
    newData: {
      changed_by: profile.id,
      notification_type: saved.notification_type,
      internal_enabled: saved.internal_enabled,
      email_enabled: saved.email_enabled,
      push_enabled: saved.push_enabled,
      frequency: saved.frequency,
      destination_roles: saved.destination_roles,
    },
  });

  revalidatePath("/admin/configuracion");
  return { ok: true, message: "Preferencia de notificación guardada." };
}

export async function saveUserNotificationPreferenceAction(input: NotificationUserPreferenceUpdate) {
  const profile = await getSessionProfile();
  if (!profile) {
    return { ok: false, message: "Debes iniciar sesión para cambiar tus notificaciones." };
  }

  const existing = await getAdminNotificationPreferenceByType(input.notification_type);
  if (existing?.technical_only && profile.role !== "technical_owner") {
    return { ok: false, message: "Solo technical_owner puede gestionar notificaciones técnicas." };
  }

  if (!existing) {
    return { ok: false, message: "Preferencia de notificación no encontrada." };
  }

  if (profile.role === "contadora" && !isAccountantNotificationType(existing.notification_type)) {
    return { ok: false, message: "La contadora solo puede configurar notificaciones fiscales." };
  }

  const saved = await saveAdminNotificationUserPreference(profile.id, input);

  await writeAuditLog({
    tableName: "notification_user_preferences",
    recordId: saved.id,
    action: "notification_user_preference.updated",
    newData: {
      changed_by: profile.id,
      notification_type: saved.notification_type,
      internal_enabled: saved.internal_enabled,
      email_enabled: saved.email_enabled,
      push_enabled: saved.push_enabled,
      frequency: saved.frequency,
    },
  });

  revalidatePath("/admin/configuracion");
  return { ok: true, message: "Tus preferencias de notificación fueron guardadas." };
}
