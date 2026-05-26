import { configureCloudinary } from "@/lib/cloudinary";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  BannerMediaType,
  BannerResourceType,
  BannerSlot,
  BannerStatus,
  HolidayBanner,
  HolidayBannerAuditEntry,
  HolidayBannerStorageSummary,
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

export async function getHolidayBannerAuditEntries(): Promise<HolidayBannerAuditEntry[]> {
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

  return (data ?? []).map((entry) => {
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

    return {
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
  } catch {
    return {
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
  }
}
