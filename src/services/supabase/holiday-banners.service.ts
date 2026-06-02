import { configureCloudinary } from "@/lib/cloudinary";
import { writeAuditLog } from "@/lib/audit";
import { requireStrictPermission } from "@/lib/auth/session";
import { writeErrorLog } from "@/lib/error-logging";
import { enqueueEmail } from "@/lib/notifications/email-queue";
import { createTechnicalNotification } from "@/lib/notifications/notification-center";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  BannerMediaType,
  BannerResourceType,
  BannerSlot,
  BannerStatus,
  HolidayBanner,
  HolidayBannerAuditEntry,
  HolidayBannerStorageSummary,
  TechnicalAlertSettings,
} from "@/types/settings";

type BannerAuditRow = {
  id: string;
  record_id: string | null;
  action: string;
  actor_role: string | null;
  old_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
  created_at: string;
  users: { email: string | null; full_name: string | null } | null;
};

type UsageValue = {
  usage?: unknown;
  limit?: unknown;
};

type TechnicalAlertSettingsRow = {
  enabled: boolean | null;
  email: string | null;
  service_account_email: string | null;
  cloudinary_storage_threshold_percent: number | null;
  last_alert_sent_at: string | null;
  last_checked_at: string | null;
};

const technicalAuditActions = new Set([
  "holiday_banner.integrity_review",
  "holiday_banner.integrity_cleanup",
  "holiday_banner.cloudinary_asset_deleted",
  "technical_alert.cloudinary_storage_sent",
  "technical_alert.cloudinary_storage_failed",
  "technical_alert_settings.updated",
]);

const defaultTechnicalAlertSettings: TechnicalAlertSettings = {
  enabled: true,
  email: process.env.TECHNICAL_ALERT_EMAIL ?? "",
  serviceAccountEmail: process.env.TECHNICAL_SERVICE_ACCOUNT_EMAIL ?? "",
  cloudinaryStorageThresholdPercent: 70,
  lastAlertSentAt: null,
  lastCheckedAt: null,
};

function bannerStatus(row: Pick<HolidayBanner, "is_active" | "start_date" | "end_date">, today = new Date().toISOString().slice(0, 10)): BannerStatus {
  if (!row.is_active) {
    return "disabled";
  }

  if (row.start_date > today) {
    return "scheduled";
  }

  if (row.end_date < today) {
    return "expired";
  }

  return "active";
}

function normalizeMediaType(value: unknown): BannerMediaType {
  return value === "video" ? "video" : "image";
}

function normalizeResourceType(value: unknown): BannerResourceType {
  return value === "video" ? "video" : "image";
}

function normalizeBannerSlot(value: unknown): BannerSlot {
  return value === "secondary" ? "secondary" : "main";
}

function normalizeBanner(row: HolidayBanner): HolidayBanner {
  const mediaType = normalizeMediaType(row.media_type);
  const mediaUrl = row.media_url ?? row.image_url ?? null;

  return {
    ...row,
    banner_slot: normalizeBannerSlot(row.banner_slot),
    image_url: row.image_url ?? null,
    media_type: mediaType,
    media_url: mediaUrl,
    media_public_id: row.media_public_id ?? null,
    media_resource_type: normalizeResourceType(row.media_resource_type),
    media_bytes: Number(row.media_bytes ?? 0),
    media_created_at: row.media_created_at ?? null,
    media_format: row.media_format ?? null,
    media_width: row.media_width ? Number(row.media_width) : null,
    media_height: row.media_height ? Number(row.media_height) : null,
    media_duration_seconds: row.media_duration_seconds ? Number(row.media_duration_seconds) : null,
    media_thumbnail_url: row.media_thumbnail_url ?? null,
    button_text: row.button_text ?? null,
    button_url: row.button_url ?? null,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    priority: Number(row.priority ?? 0),
    status: bannerStatus(row),
  };
}

export async function getActiveHolidayBanners(limit = 4): Promise<HolidayBanner[]> {
  const supabase = await getSupabaseServerClient();
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("holiday_banners")
    .select("*")
    .eq("is_active", true)
    .lte("start_date", today)
    .gte("end_date", today)
    .order("banner_slot", { ascending: true })
    .order("priority", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(Math.min(limit, 4))
    .returns<HolidayBanner[]>();

  if (error) {
    return [];
  }

  const active = (data ?? []).map(normalizeBanner);
  const main = active.filter((banner) => banner.banner_slot === "main").slice(0, 1);
  const secondary = active.filter((banner) => banner.banner_slot === "secondary").slice(0, 3);
  return [...main, ...secondary];
}

export async function getActiveHolidayBanner(): Promise<HolidayBanner | null> {
  const banners = await getActiveHolidayBanners(1);
  return banners[0] ?? null;
}

export async function getAdminHolidayBanners(): Promise<HolidayBanner[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("holiday_banners")
    .select("*")
    .order("start_date", { ascending: false })
    .order("banner_slot", { ascending: true })
    .order("priority", { ascending: false })
    .returns<HolidayBanner[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(normalizeBanner);
}

export async function getHolidayBannerAuditEntries(includeTechnical = false): Promise<HolidayBannerAuditEntry[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, record_id, action, actor_role, old_data, new_data, created_at, users(email, full_name)")
    .eq("table_name", "holiday_banners")
    .order("created_at", { ascending: false })
    .limit(80)
    .returns<BannerAuditRow[]>();

  if (error) {
    return [];
  }

  return (data ?? [])
    .filter((entry) => includeTechnical || !technicalAuditActions.has(entry.action))
    .map((entry) => {
    const nextData = entry.new_data ?? {};
    const oldData = entry.old_data ?? {};
    const title = String(nextData.title ?? oldData.title ?? "").trim();
    const mediaType = normalizeMediaType(nextData.media_type ?? oldData.media_type);

    return {
      id: entry.id,
      banner_id: entry.record_id,
      banner_title: title || null,
      action: entry.action,
      actor_name: entry.users?.full_name ?? entry.users?.email ?? "Sistema",
      actor_role: entry.actor_role,
      media_type: mediaType,
      created_at: entry.created_at,
    };
  });
}

export function sanitizeHolidayBannersForOperationalOwner(banners: HolidayBanner[]): HolidayBanner[] {
  return banners.map((banner) => ({
    ...banner,
    media_public_id: null,
    media_created_at: null,
    media_format: null,
    media_width: null,
    media_height: null,
    media_duration_seconds: banner.media_duration_seconds,
  }));
}

function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function usageBytes(value: UsageValue | undefined) {
  return numberOrNull(value?.usage);
}

function usageLimitBytes(value: UsageValue | undefined) {
  return numberOrNull(value?.limit);
}

export async function getHolidayBannerStorageSummary(): Promise<HolidayBannerStorageSummary> {
  await requireStrictPermission("system:monitoring");

  const supabase = await getSupabaseServerClient();
  const { data } = await supabase
    .from("holiday_banners")
    .select("media_type, media_bytes")
    .returns<Array<{ media_type: BannerMediaType | null; media_bytes: number | null }>>();

  const rows = data ?? [];
  const imageRows = rows.filter((row) => row.media_type !== "video");
  const videoRows = rows.filter((row) => row.media_type === "video");
  const imageBytes = imageRows.reduce((total, row) => total + Number(row.media_bytes ?? 0), 0);
  const videoBytes = videoRows.reduce((total, row) => total + Number(row.media_bytes ?? 0), 0);
  const databaseTotal = imageBytes + videoBytes;

  try {
    const cloudinary = configureCloudinary();
    const usage = (await cloudinary.api.usage()) as { storage?: UsageValue };
    const cloudinaryUsedBytes = usageBytes(usage.storage);
    const cloudinaryLimitBytes = usageLimitBytes(usage.storage);

    const summary: HolidayBannerStorageSummary = {
      imageCount: imageRows.length,
      imageBytes,
      videoCount: videoRows.length,
      videoBytes,
      totalBytes: databaseTotal,
      cloudinaryUsedBytes,
      cloudinaryLimitBytes,
      cloudinaryFreeBytes:
        cloudinaryUsedBytes !== null && cloudinaryLimitBytes !== null ? Math.max(cloudinaryLimitBytes - cloudinaryUsedBytes, 0) : null,
      source: cloudinaryUsedBytes !== null ? "cloudinary" : "database",
    };
    await maybeSendCloudinaryStorageAlert(summary);
    return summary;
  } catch {
    const summary: HolidayBannerStorageSummary = {
      imageCount: imageRows.length,
      imageBytes,
      videoCount: videoRows.length,
      videoBytes,
      totalBytes: databaseTotal,
      cloudinaryUsedBytes: null,
      cloudinaryLimitBytes: null,
      cloudinaryFreeBytes: null,
      source: "database",
    };
    await updateTechnicalAlertLastChecked();
    return summary;
  }
}

function normalizeTechnicalAlertSettings(row: TechnicalAlertSettingsRow | null | undefined): TechnicalAlertSettings {
  return {
    enabled: row?.enabled ?? defaultTechnicalAlertSettings.enabled,
    email: row?.email?.trim() || defaultTechnicalAlertSettings.email,
    serviceAccountEmail: row?.service_account_email?.trim() || defaultTechnicalAlertSettings.serviceAccountEmail,
    cloudinaryStorageThresholdPercent:
      Math.min(100, Math.max(1, Math.trunc(Number(row?.cloudinary_storage_threshold_percent ?? defaultTechnicalAlertSettings.cloudinaryStorageThresholdPercent)))),
    lastAlertSentAt: row?.last_alert_sent_at ?? null,
    lastCheckedAt: row?.last_checked_at ?? null,
  };
}

export async function getTechnicalAlertSettings(): Promise<TechnicalAlertSettings> {
  await requireStrictPermission("system:monitoring");

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("technical_alert_settings")
    .select("enabled, email, service_account_email, cloudinary_storage_threshold_percent, last_alert_sent_at, last_checked_at")
    .eq("id", true)
    .maybeSingle<TechnicalAlertSettingsRow>();

  if (error) {
    return defaultTechnicalAlertSettings;
  }

  return normalizeTechnicalAlertSettings(data);
}

export async function saveTechnicalAlertSettings(input: Pick<TechnicalAlertSettings, "enabled" | "email" | "cloudinaryStorageThresholdPercent">) {
  await requireStrictPermission("system:monitoring");

  const email = input.email.trim().toLowerCase();
  const threshold = Math.min(100, Math.max(1, Math.trunc(Number(input.cloudinaryStorageThresholdPercent) || 70)));
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from("technical_alert_settings").upsert({
    id: true,
    enabled: Boolean(input.enabled),
    email,
    cloudinary_storage_threshold_percent: threshold,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(error.message);
  }

  await writeAuditLog({
    tableName: "technical_alert_settings",
    recordId: "true",
    action: "technical_alert_settings.updated",
    newData: {
      enabled: Boolean(input.enabled),
      email,
      cloudinary_storage_threshold_percent: threshold,
    },
  });
}

async function updateTechnicalAlertLastChecked(lastAlertSentAt?: string) {
  const supabase = await getSupabaseServerClient();
  const updatePayload: Record<string, string> = {
    last_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (lastAlertSentAt) {
    updatePayload.last_alert_sent_at = lastAlertSentAt;
  }

  await supabase.from("technical_alert_settings").update(updatePayload).eq("id", true);
}

function shouldThrottleAlert(lastAlertSentAt: string | null) {
  if (!lastAlertSentAt) {
    return false;
  }

  const last = new Date(lastAlertSentAt).getTime();
  return Number.isFinite(last) && Date.now() - last < 24 * 60 * 60 * 1000;
}

async function maybeSendCloudinaryStorageAlert(summary: HolidayBannerStorageSummary) {
  const settings = await getTechnicalAlertSettings();
  const used = summary.cloudinaryUsedBytes;
  const limit = summary.cloudinaryLimitBytes;

  if (!settings.enabled || used === null || !limit) {
    await updateTechnicalAlertLastChecked();
    return;
  }

  const usedPercent = Math.round((used / limit) * 100);
  if (usedPercent < settings.cloudinaryStorageThresholdPercent || shouldThrottleAlert(settings.lastAlertSentAt)) {
    await updateTechnicalAlertLastChecked();
    return;
  }

  const sentAt = new Date().toISOString();
  const result = await enqueueEmail({
    toEmail: settings.email,
    subject: `Alerta tecnica Car Zone: almacenamiento al ${usedPercent}%`,
    templateKey: "system.cloudinary_high_usage",
    idempotencyKey: `cloudinary-storage-${usedPercent}-${sentAt.slice(0, 10)}`,
    relatedModule: "sistema",
    payload: {
      event_type: "technical.cloudinary_storage_threshold",
      used_percent: usedPercent,
      html: `
      <div style="font-family:Arial,sans-serif;color:#111827;padding:24px;">
        <h1 style="font-size:22px;margin:0 0 12px;">Alerta tecnica de almacenamiento</h1>
        <p>El uso reportado de almacenamiento esta en ${usedPercent}%.</p>
        <p>Uso: ${(used / 1024 / 1024).toFixed(2)} MB / Limite: ${(limit / 1024 / 1024).toFixed(2)} MB.</p>
        <p>Umbral configurado: ${settings.cloudinaryStorageThresholdPercent}%.</p>
      </div>
    `,
    },
  });

  await createTechnicalNotification({
    type: "system.cloudinary_high_usage",
    title: "Uso alto de Cloudinary",
    message: `El uso reportado de almacenamiento esta en ${usedPercent}%.`,
    severity: "warning",
    metadata: {
      used_percent: usedPercent,
      threshold_percent: settings.cloudinaryStorageThresholdPercent,
      queue_id: result.id,
    },
    dedupeKey: `system.cloudinary_high_usage:${sentAt.slice(0, 10)}`,
  });

  await updateTechnicalAlertLastChecked(result.queued || result.reason === "duplicate" ? sentAt : undefined);

  await writeAuditLog({
    tableName: "technical_alert_settings",
    recordId: "true",
    action: result.queued || result.reason === "duplicate" ? "technical_alert.cloudinary_storage_queued" : "technical_alert.cloudinary_storage_failed",
    newData: {
      status: result.reason ?? "queued",
      provider: "email_queue",
      recipient_email: settings.email,
      used_percent: usedPercent,
      threshold_percent: settings.cloudinaryStorageThresholdPercent,
      queue_id: result.id,
    },
  });

  if (!result.queued && result.reason !== "duplicate") {
    await writeErrorLog({
      route: "/admin/banners",
      action: "technical_alert.cloudinary_storage_failed",
      errorMessage: "No se pudo encolar la alerta tecnica.",
      metadata: {
        provider: "email_queue",
        queue_result: result.reason,
        used_percent: usedPercent,
      },
    });
  }
}
