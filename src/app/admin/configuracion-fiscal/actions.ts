"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import sharp from "sharp";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { configureCloudinary } from "@/lib/cloudinary";
import { writeErrorLog } from "@/lib/error-logging";
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
import {
  fiscalLogoFolder,
  fiscalLogoInvalidFormatMessage,
  fiscalLogoMaxBytes,
  fiscalLogoMaxDisplayWidth,
  fiscalLogoMaxPixels,
  fiscalLogoSavedMessage,
  fiscalLogoTooLargeMessage,
  fiscalLogoTooManyPixelsMessage,
  isAllowedFiscalLogoMimeType,
} from "@/utils/fiscal-logo-rules";

type FiscalLogoMutation = {
  ok: boolean;
  message?: string;
  logoUrl?: string | null;
  uploadedPublicId?: string | null;
};

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
  await requirePermission("commercial_settings:manage");

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
    "notify_general_contact",
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

function parseFiscalSettingsForm(formData: FormData, fallbackLogoUrl: string | null): FiscalSettings {
  return {
    legal_name: String(formData.get("legal_name") ?? ""),
    rtn: String(formData.get("rtn") ?? ""),
    cai: String(formData.get("cai") ?? ""),
    invoice_range_start: String(formData.get("invoice_range_start") ?? ""),
    invoice_range_end: String(formData.get("invoice_range_end") ?? ""),
    current_invoice_number: String(formData.get("current_invoice_number") ?? ""),
    emission_deadline: String(formData.get("emission_deadline") ?? "") || null,
    fiscal_address: String(formData.get("fiscal_address") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    logo_url: fallbackLogoUrl,
  };
}

function getCloudinaryLogoPublicId(url: string | null | undefined) {
  if (!url) {
    return null;
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "res.cloudinary.com") {
      return null;
    }

    const marker = `/${cloudName}/image/upload/`;
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex < 0) {
      return null;
    }

    const afterUpload = parsed.pathname.slice(markerIndex + marker.length);
    const segments = afterUpload.split("/").filter(Boolean);
    const withoutVersion = segments[0]?.startsWith("v") && /^v\d+$/.test(segments[0]) ? segments.slice(1) : segments;
    const path = withoutVersion.join("/");
    const withoutExtension = path.replace(/\.[^.]+$/, "");

    return withoutExtension.startsWith(`${fiscalLogoFolder}/`) ? withoutExtension : null;
  } catch {
    return null;
  }
}

async function deleteFiscalLogoIfOwned(url: string | null | undefined, context: Record<string, unknown>) {
  const publicId = getCloudinaryLogoPublicId(url);
  if (!publicId) {
    return;
  }

  try {
    const cloudinary = configureCloudinary();
    await cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true });
  } catch (error) {
    await writeErrorLog({
      route: "/admin/configuracion-fiscal",
      action: "fiscal.logo_delete_failed",
      errorMessage: error instanceof Error ? error.message : "No se pudo eliminar el logo fiscal anterior.",
      errorStack: error instanceof Error ? error.stack : null,
      metadata: { ...context, public_id: publicId },
    });
  }
}

async function uploadFiscalLogo(file: File): Promise<FiscalLogoMutation> {
  if (!isAllowedFiscalLogoMimeType(file.type)) {
    return { ok: false, message: fiscalLogoInvalidFormatMessage };
  }

  if (file.size > fiscalLogoMaxBytes) {
    return { ok: false, message: fiscalLogoTooLargeMessage };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let optimizedBuffer: Buffer;
  let width = 0;
  let height = 0;

  try {
    const metadata = await sharp(buffer, { animated: false, limitInputPixels: fiscalLogoMaxPixels + 1 })
      .rotate()
      .metadata();
    width = metadata.width ?? 0;
    height = metadata.height ?? 0;
    const format = metadata.format?.toLowerCase();

    if (!format || !["jpeg", "jpg", "png", "webp"].includes(format)) {
      return { ok: false, message: fiscalLogoInvalidFormatMessage };
    }

    if (!width || !height) {
      return { ok: false, message: fiscalLogoInvalidFormatMessage };
    }

    if (width * height > fiscalLogoMaxPixels) {
      return { ok: false, message: fiscalLogoTooManyPixelsMessage };
    }

    optimizedBuffer = await sharp(buffer, { animated: false })
      .rotate()
      .resize({
        width: fiscalLogoMaxDisplayWidth,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 86, effort: 5 })
      .toBuffer();
  } catch (error) {
    const message =
      error instanceof Error && error.message.toLowerCase().includes("pixel")
        ? fiscalLogoTooManyPixelsMessage
        : fiscalLogoInvalidFormatMessage;
    return { ok: false, message };
  }

  const cloudinary = configureCloudinary();
  const publicId = `fiscal-logo-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const result = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: fiscalLogoFolder,
        public_id: publicId,
        resource_type: "image",
        format: "webp",
        overwrite: false,
        invalidate: true,
        context: {
          source: "fiscal_settings",
          original_bytes: String(file.size),
          original_mime: file.type,
          original_pixels: String(width * height),
          optimized_bytes: String(optimizedBuffer.length),
        },
      },
      (error, uploadResult) => {
        if (error || !uploadResult?.secure_url || !uploadResult.public_id) {
          reject(error ?? new Error("Cloudinary no devolvió una URL válida."));
          return;
        }

        resolve({
          secure_url: uploadResult.secure_url,
          public_id: uploadResult.public_id,
        });
      },
    );

    stream.end(optimizedBuffer);
  });

  return {
    ok: true,
    logoUrl: result.secure_url,
    uploadedPublicId: result.public_id,
  };
}

async function resolveFiscalLogo(formData: FormData, previousLogoUrl: string | null): Promise<FiscalLogoMutation> {
  const logoAction = String(formData.get("logo_action") ?? "keep");

  if (logoAction === "remove") {
    return { ok: true, logoUrl: null };
  }

  if (logoAction !== "replace") {
    return { ok: true, logoUrl: previousLogoUrl };
  }

  const file = formData.get("logo_file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Selecciona un logo antes de guardar." };
  }

  return uploadFiscalLogo(file);
}

export async function saveFiscalSettingsAction(formData: FormData) {
  await requirePermission("settings:fiscal");
  const previousSettings = await getFiscalSettings();
  const logoResult = await resolveFiscalLogo(formData, previousSettings.logo_url);

  if (!logoResult.ok) {
    return { ok: false, message: logoResult.message ?? "No se pudo procesar el logo fiscal." };
  }

  const input = parseFiscalSettingsForm(formData, logoResult.logoUrl ?? null);

  if (!input.legal_name.trim()) {
    if (logoResult.uploadedPublicId) {
      await deleteFiscalLogoIfOwned(logoResult.logoUrl, { reason: "fiscal_settings_validation_failed" });
    }
    return { ok: false, message: "El nombre legal de la empresa es obligatorio." };
  }

  try {
    await saveFiscalSettings(input);
  } catch (error) {
    if (logoResult.uploadedPublicId) {
      await deleteFiscalLogoIfOwned(logoResult.logoUrl, { reason: "fiscal_settings_save_failed" });
    }
    throw error;
  }

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

  if (previousSettings.logo_url !== input.logo_url && previousSettings.logo_url) {
    await deleteFiscalLogoIfOwned(previousSettings.logo_url, {
      reason: input.logo_url ? "fiscal_logo_replaced" : "fiscal_logo_removed",
    });
  }

  revalidatePath("/admin/configuracion-fiscal");
  revalidatePath("/admin/facturas");
  revalidatePath("/admin/reportes");

  return {
    ok: true,
    message: previousSettings.logo_url !== input.logo_url ? fiscalLogoSavedMessage : "Configuración fiscal guardada correctamente.",
    logoUrl: input.logo_url,
  };
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
