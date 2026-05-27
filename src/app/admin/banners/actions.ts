"use server";

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import sharp from "sharp";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission, requireStrictPermission } from "@/lib/auth/session";
import { configureCloudinary } from "@/lib/cloudinary";
import { writeErrorLog } from "@/lib/error-logging";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { saveTechnicalAlertSettings } from "@/services/supabase/holiday-banners.service";
import type { BannerMediaType, BannerResourceType, BannerSlot, HolidayBanner, HolidayBannerInput, TechnicalAlertSettings } from "@/types/settings";

type BannerMutationResult = {
  ok: boolean;
  message: string;
};

type BannerMediaUploadResult = BannerMutationResult & {
  mediaUrl?: string;
  assetToken?: string;
  mediaType?: BannerMediaType;
  bytes?: number;
  createdAt?: string;
  format?: string;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  thumbnailUrl?: string;
};

type BannerIntegrityResult = BannerMutationResult & {
  orphanCloudinaryFiles?: number;
  invalidRecords?: number;
  deletedOrphans?: number;
};

type CloudinaryUploadResult = {
  secure_url?: string;
  public_id?: string;
  resource_type?: string;
  bytes?: number;
  created_at?: string;
  format?: string;
  width?: number;
  height?: number;
  duration?: number;
  eager?: Array<{ secure_url?: string; format?: string; bytes?: number; width?: number; height?: number }>;
};

type BannerMediaRecord = Pick<
  HolidayBanner,
  | "id"
  | "title"
  | "media_type"
  | "media_url"
  | "media_public_id"
  | "media_resource_type"
  | "media_thumbnail_url"
  | "image_url"
  | "media_bytes"
>;

type BannerAssetTokenPayload = {
  publicId: string;
  resourceType: BannerResourceType;
  mediaType: BannerMediaType;
  mediaUrl: string;
  imageUrl: string;
  bytes: number;
  createdAt: string;
  format: string;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  thumbnailUrl: string;
  expiresAt: number;
};

const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowedImageExtensions = new Set(["jpg", "jpeg", "png", "webp"]);
const allowedVideoTypes = new Set(["video/mp4", "video/webm"]);
const allowedVideoExtensions = new Set(["mp4", "webm"]);
const imageMaxBytes = 5 * 1024 * 1024;
const videoMaxBytes = 25 * 1024 * 1024;
const videoMaxDurationSeconds = 60;
const bannerSlotLimits: Record<BannerSlot, number> = {
  main: 1,
  secondary: 3,
};
const assetTokenTtlMs = 24 * 60 * 60 * 1000;

function cleanText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function cleanOptional(value: string | null | undefined) {
  const trimmed = cleanText(value);
  return trimmed.length > 0 ? trimmed : null;
}

function fileExtension(file: File) {
  const name = file.name.toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1) : "";
}

function clampPriority(value: unknown) {
  const number = Math.trunc(Number(value) || 1);
  return Math.min(5, Math.max(1, number));
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

function validateUploadFile(file: File, mediaType: BannerMediaType) {
  const extension = fileExtension(file);

  if (mediaType === "image") {
    if (!allowedImageTypes.has(file.type) || !allowedImageExtensions.has(extension)) {
      throw new Error("Formato no permitido. Usa JPG, JPEG, PNG o WEBP. No se aceptan SVG, TIFF ni BMP.");
    }

    if (file.size > imageMaxBytes) {
      throw new Error("La imagen no puede superar 5 MB.");
    }

    return;
  }

  if (!allowedVideoTypes.has(file.type) || !allowedVideoExtensions.has(extension)) {
    throw new Error("Formato no permitido. Usa video MP4 o WEBM. No se aceptan AVI, MOV ni formatos pesados.");
  }

  if (file.size > videoMaxBytes) {
    throw new Error("El video no puede superar 25 MB.");
  }
}

function revalidateBanners() {
  revalidatePath("/");
  revalidatePath("/admin/banners");
}

function cloudinaryBannerPublicId(mediaType: BannerMediaType) {
  return `${mediaType}-${randomUUID()}`;
}

function cloudinaryVideoPosterUrl(secureUrl: string) {
  return secureUrl.replace("/video/upload/", "/video/upload/so_0,w_900,h_500,c_fill,g_auto,q_auto,f_jpg/").replace(/\.(mp4|webm)(\?.*)?$/i, ".jpg$2");
}

function getAssetTokenKey() {
  const material = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!material) {
    throw new Error("No hay llave interna configurada para proteger los archivos de banners.");
  }

  return createHash("sha256").update(material).digest();
}

function createAssetToken(payload: Omit<BannerAssetTokenPayload, "expiresAt">) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getAssetTokenKey(), iv);
  const body = Buffer.from(JSON.stringify({ ...payload, expiresAt: Date.now() + assetTokenTtlMs }), "utf8");
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function readAssetToken(token: string | null | undefined): BannerAssetTokenPayload | null {
  const cleanToken = cleanOptional(token);
  if (!cleanToken || !cleanToken.includes(".")) {
    return null;
  }

  try {
    const [ivValue, tagValue, encryptedValue] = cleanToken.split(".");
    if (!ivValue || !tagValue || !encryptedValue) {
      return null;
    }

    const decipher = createDecipheriv("aes-256-gcm", getAssetTokenKey(), Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]);
    const payload = JSON.parse(decrypted.toString("utf8")) as BannerAssetTokenPayload;

    if (!payload.publicId || !payload.mediaUrl || payload.expiresAt < Date.now()) {
      return null;
    }

    return {
      ...payload,
      mediaType: normalizeMediaType(payload.mediaType),
      resourceType: normalizeResourceType(payload.resourceType),
    };
  } catch {
    return null;
  }
}

async function destroyBannerMedia(publicId: string | null | undefined, resourceType: BannerResourceType | null | undefined, context: Record<string, unknown>) {
  const cleanPublicId = cleanOptional(publicId);
  if (!cleanPublicId) {
    return;
  }

  try {
    const cloudinary = configureCloudinary();
    const result = await cloudinary.uploader.destroy(cleanPublicId, {
      resource_type: normalizeResourceType(resourceType),
      invalidate: true,
    });

    const resultValue = typeof result === "object" && result ? String((result as { result?: unknown }).result ?? "") : "";
    if (resultValue && !["ok", "not found"].includes(resultValue)) {
      throw new Error(`Cloudinary respondio: ${resultValue}`);
    }

    await writeAuditLog({
      tableName: "holiday_banners",
      recordId: typeof context.banner_id === "string" ? context.banner_id : null,
      action: "holiday_banner.cloudinary_asset_deleted",
      newData: {
        ...context,
        public_id: cleanPublicId,
        resource_type: normalizeResourceType(resourceType),
        cloudinary_result: resultValue || "ok",
      },
    });
  } catch (error) {
    await writeErrorLog({
      route: "/admin/banners",
      action: "holiday_banner.cloudinary_delete_failed",
      errorMessage: error instanceof Error ? error.message : "No se pudo eliminar el archivo de Cloudinary.",
      errorStack: error instanceof Error ? error.stack : null,
      metadata: { ...context, public_id: cleanPublicId, resource_type: resourceType },
    });
    throw error;
  }
}

function normalizeBanner(input: HolidayBannerInput, actorId: string, existing: HolidayBanner | null) {
  const title = cleanText(input.title);
  const message = cleanText(input.message);
  const startDate = cleanText(input.start_date);
  const endDate = cleanText(input.end_date);
  const tokenPayload = readAssetToken(input.media_asset_token);
  const mediaType = normalizeMediaType(tokenPayload?.mediaType ?? input.media_type);
  const mediaUrl = cleanOptional(tokenPayload?.mediaUrl ?? input.media_url ?? input.image_url) ?? existing?.media_url ?? existing?.image_url ?? null;
  const mediaPublicId = cleanOptional(tokenPayload?.publicId ?? input.media_public_id) ?? existing?.media_public_id ?? null;
  const resourceType = normalizeResourceType(tokenPayload?.resourceType ?? input.media_resource_type ?? existing?.media_resource_type ?? mediaType);
  const bannerSlot = normalizeBannerSlot(input.banner_slot);

  if (!title || !message || !startDate || !endDate) {
    throw new Error("Titulo, mensaje y fechas son obligatorios.");
  }

  if (endDate < startDate) {
    throw new Error("La fecha final no puede ser anterior a la fecha inicial.");
  }

  if (!mediaUrl || !mediaPublicId) {
    throw new Error(mediaType === "video" ? "Sube un video antes de guardar el banner." : "Sube una imagen antes de guardar el banner.");
  }

  if (mediaType === "video" && Number(input.media_duration_seconds ?? 0) > videoMaxDurationSeconds) {
    throw new Error("El video no puede durar mas de 60 segundos.");
  }

  return {
    title,
    message,
    banner_slot: bannerSlot,
    image_url: mediaType === "image" ? mediaUrl : null,
    media_type: mediaType,
    media_url: mediaUrl,
    media_public_id: mediaPublicId,
    media_resource_type: resourceType,
    media_bytes: Math.max(0, Math.trunc(Number(tokenPayload?.bytes ?? input.media_bytes ?? existing?.media_bytes) || 0)),
    media_created_at: cleanOptional(tokenPayload?.createdAt ?? input.media_created_at) ?? existing?.media_created_at ?? null,
    media_format: cleanOptional(tokenPayload?.format ?? input.media_format) ?? existing?.media_format ?? null,
    media_width: tokenPayload?.width ?? (input.media_width ? Math.trunc(Number(input.media_width)) : existing?.media_width ?? null),
    media_height: tokenPayload?.height ?? (input.media_height ? Math.trunc(Number(input.media_height)) : existing?.media_height ?? null),
    media_duration_seconds: tokenPayload?.durationSeconds ?? (input.media_duration_seconds ? Number(input.media_duration_seconds) : existing?.media_duration_seconds ?? null),
    media_thumbnail_url: cleanOptional(tokenPayload?.thumbnailUrl ?? input.media_thumbnail_url) ?? existing?.media_thumbnail_url ?? null,
    start_date: startDate,
    end_date: endDate,
    is_active: Boolean(input.is_active),
    priority: clampPriority(input.priority),
    button_text: cleanOptional(input.button_text),
    button_url: cleanOptional(input.button_url),
    updated_by: actorId,
    updated_at: new Date().toISOString(),
  };
}

async function assertBannerSlotCapacity(input: {
  id?: string;
  bannerSlot: BannerSlot;
  startDate: string;
  endDate: string;
  isActive: boolean;
}) {
  if (!input.isActive) {
    return;
  }

  const supabase = await getSupabaseServerClient();
  let query = supabase
    .from("holiday_banners")
    .select("id", { count: "exact", head: true })
    .eq("is_active", true)
    .eq("banner_slot", input.bannerSlot)
    .lte("start_date", input.endDate)
    .gte("end_date", input.startDate);

  if (input.id) {
    query = query.neq("id", input.id);
  }

  const { count, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  if ((count ?? 0) >= bannerSlotLimits[input.bannerSlot]) {
    throw new Error(
      input.bannerSlot === "main"
        ? "Ya existe un banner principal activo en ese rango de fechas."
        : "Ya existen 3 banners secundarios activos en ese rango de fechas.",
    );
  }
}

async function getExistingBanner(id: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("holiday_banners")
    .select("*")
    .eq("id", id)
    .maybeSingle<HolidayBanner>();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export async function saveHolidayBannerAction(input: HolidayBannerInput): Promise<BannerMutationResult> {
  const profile = await requirePermission("commercial_settings:manage");
  const canViewTechnical = profile.permissions.includes("system:monitoring");

  try {
    const supabase = await getSupabaseServerClient();
    const existing = input.id ? await getExistingBanner(input.id) : null;
    if (!canViewTechnical && input.media_public_id && input.media_public_id !== (existing?.media_public_id ?? "")) {
      return { ok: false, message: "El archivo debe venir de una carga valida del panel." };
    }

    const payload = normalizeBanner(input, profile.id, existing);
    await assertBannerSlotCapacity({
      id: input.id,
      bannerSlot: payload.banner_slot,
      startDate: payload.start_date,
      endDate: payload.end_date,
      isActive: payload.is_active,
    });
    const createPayload = input.id ? payload : { ...payload, created_by: profile.id };
    const query = input.id
      ? supabase.from("holiday_banners").update(createPayload).eq("id", input.id).select("id").single<{ id: string }>()
      : supabase.from("holiday_banners").insert(createPayload).select("id").single<{ id: string }>();

    const { data, error } = await query;

    if (error) {
      throw new Error(error.message);
    }

    if (existing?.media_public_id && existing.media_public_id !== payload.media_public_id) {
      await destroyBannerMedia(existing.media_public_id, existing.media_resource_type, {
        banner_id: data.id,
        reason: "holiday_banner_media_replaced",
      });
    }

    await writeAuditLog({
      tableName: "holiday_banners",
      recordId: data.id,
      action: input.id ? "holiday_banner.updated" : "holiday_banner.created",
      oldData: existing
        ? {
            media_public_id: existing.media_public_id,
            media_type: existing.media_type,
            banner_slot: existing.banner_slot,
            priority: existing.priority,
            is_active: existing.is_active,
          }
        : null,
      newData: {
        ...payload,
        actor_id: profile.id,
        actor_role: profile.role,
      },
    });

    revalidateBanners();

    return { ok: true, message: input.id ? "Banner actualizado correctamente." : "Banner creado correctamente." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo guardar el banner." };
  }
}

export async function toggleHolidayBannerAction(id: string, isActive: boolean): Promise<BannerMutationResult> {
  const profile = await requirePermission("commercial_settings:manage");
  const supabase = await getSupabaseServerClient();
  const { data: banner, error: bannerError } = await supabase
    .from("holiday_banners")
    .select("id, banner_slot, start_date, end_date")
    .eq("id", id)
    .maybeSingle<{ id: string; banner_slot: BannerSlot | null; start_date: string; end_date: string }>();

  if (bannerError || !banner) {
    return { ok: false, message: bannerError?.message ?? "Banner no encontrado." };
  }

  try {
    await assertBannerSlotCapacity({
      id,
      bannerSlot: normalizeBannerSlot(banner.banner_slot),
      startDate: banner.start_date,
      endDate: banner.end_date,
      isActive,
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo activar el banner." };
  }

  const { error } = await supabase
    .from("holiday_banners")
    .update({ is_active: isActive, updated_by: profile.id, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "holiday_banners",
    recordId: id,
    action: isActive ? "holiday_banner.activated" : "holiday_banner.deactivated",
    newData: { is_active: isActive, actor_id: profile.id, actor_role: profile.role },
  });

  revalidateBanners();
  return { ok: true, message: isActive ? "Banner activado." : "Banner desactivado." };
}

export async function updateHolidayBannerPriorityAction(id: string, priority: number): Promise<BannerMutationResult> {
  const profile = await requirePermission("commercial_settings:manage");
  const nextPriority = clampPriority(priority);
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from("holiday_banners")
    .update({ priority: nextPriority, updated_by: profile.id, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "holiday_banners",
    recordId: id,
    action: "holiday_banner.priority_updated",
    newData: { priority: nextPriority, actor_id: profile.id, actor_role: profile.role },
  });

  revalidateBanners();
  return { ok: true, message: "Prioridad actualizada." };
}

export async function deleteHolidayBannerAction(id: string): Promise<BannerMutationResult> {
  const profile = await requirePermission("commercial_settings:manage");
  const canViewTechnical = profile.permissions.includes("system:monitoring");
  const supabase = await getSupabaseServerClient();
  const { data: banner, error: bannerError } = await supabase
    .from("holiday_banners")
    .select("*")
    .eq("id", id)
    .maybeSingle<HolidayBanner>();

  if (bannerError || !banner) {
    return { ok: false, message: bannerError?.message ?? "Banner no encontrado." };
  }

  try {
    await destroyBannerMedia(banner.media_public_id, banner.media_resource_type, {
      banner_id: id,
      reason: "holiday_banner_deleted",
    });
  } catch {
    return {
      ok: false,
      message: canViewTechnical
        ? "No se elimino el banner porque Cloudinary no confirmo la eliminacion del archivo."
        : "No se elimino el banner porque el proveedor de archivos no confirmo la eliminacion.",
    };
  }

  const { error } = await supabase.from("holiday_banners").delete().eq("id", id);

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "holiday_banners",
    recordId: id,
    action: "holiday_banner.deleted",
    oldData: {
      ...banner,
      actor_id: profile.id,
      actor_role: profile.role,
      deleted_media_public_id: banner.media_public_id,
      deleted_media_type: banner.media_type,
    },
  });

  revalidateBanners();
  return {
    ok: true,
    message: canViewTechnical ? "Banner, archivo y derivados de Cloudinary eliminados correctamente." : "Banner y archivo eliminados correctamente.",
  };
}

export async function uploadHolidayBannerMediaAction(formData: FormData): Promise<BannerMediaUploadResult> {
  const profile = await requirePermission("commercial_settings:manage");

  try {
    const mediaType = normalizeMediaType(formData.get("mediaType"));
    const file = formData.get("file");

    if (!(file instanceof File) || file.size === 0) {
      return { ok: false, message: mediaType === "video" ? "Selecciona un video para subir." : "Selecciona una imagen para subir." };
    }

    validateUploadFile(file, mediaType);

    return mediaType === "video"
      ? await uploadBannerVideo(file, profile.id)
      : await uploadBannerImage(file, profile.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo subir el archivo.";
    const publicMessage = profile.permissions.includes("system:monitoring") ? message : message.replaceAll("Cloudinary", "el proveedor de archivos");
    await writeErrorLog({
      route: "/admin/banners",
      action: "holiday_banner.media_upload_failed",
      errorMessage: message,
      errorStack: error instanceof Error ? error.stack : null,
      metadata: {
        user_id: profile.id,
        file_name: formData.get("file") instanceof File ? (formData.get("file") as File).name : null,
        media_type: String(formData.get("mediaType") ?? ""),
      },
    });
    return { ok: false, message: publicMessage };
  }
}

async function uploadBannerImage(file: File, actorId: string): Promise<BannerMediaUploadResult> {
  const cloudinary = configureCloudinary();
  const buffer = Buffer.from(await file.arrayBuffer());
  let optimizedBuffer: Buffer;
  let width = 0;
  let height = 0;

  try {
    const metadata = await sharp(buffer, { animated: false, limitInputPixels: 18_000_001 }).rotate().metadata();
    width = metadata.width ?? 0;
    height = metadata.height ?? 0;

    if (!width || !height) {
      return { ok: false, message: "La imagen no es valida o esta danada." };
    }

    optimizedBuffer = await sharp(buffer, { animated: false })
      .rotate()
      .resize({ width: 1920, height: 900, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 5 })
      .toBuffer();
  } catch {
    return { ok: false, message: "La imagen no es valida o usa un formato no permitido." };
  }

  const result = await new Promise<CloudinaryUploadResult>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "car-zone/banners",
        public_id: cloudinaryBannerPublicId("image"),
        resource_type: "image",
        format: "webp",
        overwrite: false,
        invalidate: true,
        context: {
          source: "holiday_banner_admin",
          actor_id: actorId,
          original_bytes: String(file.size),
          optimized_bytes: String(optimizedBuffer.length),
        },
      },
      (error, uploadResult) => {
        if (error || !uploadResult?.secure_url || !uploadResult.public_id) {
          reject(error ?? new Error("Cloudinary no devolvio una URL valida."));
          return;
        }

        resolve(uploadResult as CloudinaryUploadResult);
      },
    );

    stream.end(optimizedBuffer);
  });

  const publicId = result.public_id;
  const secureUrl = result.secure_url;
  if (!publicId || !secureUrl) {
    return { ok: false, message: "El proveedor de archivos no devolvio los datos completos." };
  }

  return {
    ok: true,
    message: "Imagen optimizada y subida correctamente.",
    mediaUrl: secureUrl,
    assetToken: createAssetToken({
      publicId,
      resourceType: "image",
      mediaType: "image",
      mediaUrl: secureUrl,
      imageUrl: secureUrl,
      bytes: Number(result.bytes ?? optimizedBuffer.length),
      createdAt: result.created_at ?? new Date().toISOString(),
      format: result.format ?? "webp",
      width: result.width ?? width,
      height: result.height ?? height,
      durationSeconds: null,
      thumbnailUrl: secureUrl,
    }),
    mediaType: "image",
    bytes: Number(result.bytes ?? optimizedBuffer.length),
    createdAt: result.created_at ?? new Date().toISOString(),
    format: result.format ?? "webp",
    width: result.width ?? width,
    height: result.height ?? height,
    durationSeconds: null,
    thumbnailUrl: secureUrl,
  };
}

async function uploadBannerVideo(file: File, actorId: string): Promise<BannerMediaUploadResult> {
  const cloudinary = configureCloudinary();
  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await new Promise<CloudinaryUploadResult>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "car-zone/banners",
        public_id: cloudinaryBannerPublicId("video"),
        resource_type: "video",
        overwrite: false,
        invalidate: true,
        eager: [
          { width: 1600, crop: "limit", quality: "auto", format: "mp4" },
          { width: 900, height: 500, crop: "fill", gravity: "auto", quality: "auto", format: "jpg", start_offset: "0" },
        ],
        eager_async: false,
        context: {
          source: "holiday_banner_admin",
          actor_id: actorId,
          original_bytes: String(file.size),
        },
      },
      (error, uploadResult) => {
        if (error || !uploadResult?.secure_url || !uploadResult.public_id) {
          reject(error ?? new Error("Cloudinary no devolvio una URL valida para el video."));
          return;
        }

        resolve(uploadResult as CloudinaryUploadResult);
      },
    );

    stream.end(buffer);
  });

  const duration = Number(result.duration ?? 0);
  const publicId = result.public_id;
  if (!publicId || !result.secure_url) {
    return { ok: false, message: "El proveedor de archivos no devolvio los datos completos del video." };
  }

  if (duration > videoMaxDurationSeconds) {
    await destroyBannerMedia(publicId, "video", { reason: "holiday_banner_video_duration_rejected" });
    return { ok: false, message: "El video no puede durar mas de 60 segundos." };
  }

  const optimizedVideo = result.eager?.find((item) => item.format === "mp4" && item.secure_url)?.secure_url ?? result.secure_url;
  const thumbnail = result.eager?.find((item) => item.format === "jpg" && item.secure_url)?.secure_url ?? (result.secure_url ? cloudinaryVideoPosterUrl(result.secure_url) : undefined);

  return {
    ok: true,
    message: "Video subido y optimizado correctamente.",
    mediaUrl: optimizedVideo,
    assetToken: createAssetToken({
      publicId,
      resourceType: "video",
      mediaType: "video",
      mediaUrl: optimizedVideo,
      imageUrl: "",
      bytes: Number(result.bytes ?? file.size),
      createdAt: result.created_at ?? new Date().toISOString(),
      format: result.format ?? fileExtension(file),
      width: result.width ?? null,
      height: result.height ?? null,
      durationSeconds: duration || null,
      thumbnailUrl: thumbnail ?? "",
    }),
    mediaType: "video",
    bytes: Number(result.bytes ?? file.size),
    createdAt: result.created_at ?? new Date().toISOString(),
    format: result.format ?? fileExtension(file),
    width: result.width ?? null,
    height: result.height ?? null,
    durationSeconds: duration || null,
    thumbnailUrl: thumbnail,
  };
}

export async function deleteUploadedHolidayBannerMediaAction(mediaReference: string, resourceType?: BannerResourceType): Promise<BannerMutationResult> {
  const profile = await requirePermission("commercial_settings:manage");

  try {
    const tokenPayload = readAssetToken(mediaReference);
    if (!tokenPayload && !profile.permissions.includes("system:monitoring")) {
      return { ok: false, message: "El archivo debe venir de una carga valida del panel." };
    }

    const publicId = tokenPayload?.publicId ?? mediaReference;
    const resolvedResourceType = tokenPayload?.resourceType ?? normalizeResourceType(resourceType);
    await destroyBannerMedia(publicId, resolvedResourceType, { reason: "unsaved_holiday_banner_media_removed" });
    return { ok: true, message: "Archivo eliminado correctamente." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo eliminar el archivo." };
  }
}

export async function reviewHolidayBannerIntegrityAction(deleteOrphans = false): Promise<BannerIntegrityResult> {
  await requireStrictPermission("system:monitoring");

  try {
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase
      .from("holiday_banners")
      .select("id, title, media_type, media_url, media_public_id, media_resource_type, media_thumbnail_url, image_url, media_bytes")
      .returns<BannerMediaRecord[]>();

    if (error) {
      throw new Error(error.message);
    }

    const records = data ?? [];
    const publicIds = new Set(records.map((banner) => banner.media_public_id).filter(Boolean));
    const invalidRecords = records.filter((banner) => !banner.media_url || !banner.media_public_id || !banner.media_resource_type).length;
    const cloudinary = configureCloudinary();
    const [imageResources, videoResources] = await Promise.all([
      cloudinary.api.resources({ resource_type: "image", type: "upload", prefix: "car-zone/banners", max_results: 500 }),
      cloudinary.api.resources({ resource_type: "video", type: "upload", prefix: "car-zone/banners", max_results: 500 }),
    ]);
    const resources = [
      ...((imageResources as { resources?: Array<{ public_id: string }> }).resources ?? []).map((item) => ({ ...item, resource_type: "image" as const })),
      ...((videoResources as { resources?: Array<{ public_id: string }> }).resources ?? []).map((item) => ({ ...item, resource_type: "video" as const })),
    ];
    const orphans = resources.filter((resource) => !publicIds.has(resource.public_id));

    let deletedOrphans = 0;
    if (deleteOrphans) {
      for (const orphan of orphans) {
        await destroyBannerMedia(orphan.public_id, orphan.resource_type, { reason: "holiday_banner_integrity_cleanup" });
        deletedOrphans += 1;
      }
    }

    await writeAuditLog({
      tableName: "holiday_banners",
      action: deleteOrphans ? "holiday_banner.integrity_cleanup" : "holiday_banner.integrity_review",
      newData: {
        orphan_cloudinary_files: orphans.length,
        invalid_records: invalidRecords,
        deleted_orphans: deletedOrphans,
      },
    });

    return {
      ok: true,
      message: deleteOrphans
        ? `Revision completa. Archivos huerfanos eliminados: ${deletedOrphans}. Registros invalidos: ${invalidRecords}.`
        : `Revision completa. Huerfanos en Cloudinary: ${orphans.length}. Registros invalidos: ${invalidRecords}.`,
      orphanCloudinaryFiles: orphans.length,
      invalidRecords,
      deletedOrphans,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo revisar la integridad de banners." };
  }
}

export async function saveTechnicalAlertSettingsAction(
  input: Pick<TechnicalAlertSettings, "enabled" | "email" | "cloudinaryStorageThresholdPercent">,
): Promise<BannerMutationResult> {
  await requireStrictPermission("system:monitoring");

  try {
    const email = cleanText(input.email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, message: "Ingresa un correo tecnico valido." };
    }

    await saveTechnicalAlertSettings({
      enabled: Boolean(input.enabled),
      email,
      cloudinaryStorageThresholdPercent: Math.min(100, Math.max(1, Math.trunc(Number(input.cloudinaryStorageThresholdPercent) || 70))),
    });
    revalidatePath("/admin/banners");
    return { ok: true, message: "Configuracion tecnica de alertas actualizada." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo guardar la configuracion tecnica." };
  }
}
