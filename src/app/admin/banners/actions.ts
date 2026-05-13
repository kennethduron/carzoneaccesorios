"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { configureCloudinary } from "@/lib/cloudinary";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { HolidayBannerInput } from "@/types/settings";

type BannerMutationResult = {
  ok: boolean;
  message: string;
  imageUrl?: string;
};

function cleanText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function cleanOptional(value: string | null | undefined) {
  const trimmed = cleanText(value);
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBanner(input: HolidayBannerInput) {
  const title = cleanText(input.title);
  const message = cleanText(input.message);
  const startDate = cleanText(input.start_date);
  const endDate = cleanText(input.end_date);

  if (!title || !message || !startDate || !endDate) {
    throw new Error("Titulo, mensaje y fechas son obligatorios.");
  }

  if (endDate < startDate) {
    throw new Error("La fecha final no puede ser anterior a la fecha inicial.");
  }

  return {
    title,
    message,
    image_url: cleanOptional(input.image_url),
    start_date: startDate,
    end_date: endDate,
    is_active: Boolean(input.is_active),
    priority: Math.trunc(Number(input.priority) || 0),
    button_text: cleanOptional(input.button_text),
    button_url: cleanOptional(input.button_url),
    updated_at: new Date().toISOString(),
  };
}

export async function saveHolidayBannerAction(input: HolidayBannerInput): Promise<BannerMutationResult> {
  await requirePermission("settings:manage");

  try {
    const payload = normalizeBanner(input);
    const supabase = await getSupabaseServerClient();
    const query = input.id
      ? supabase.from("holiday_banners").update(payload).eq("id", input.id).select("id").single<{ id: string }>()
      : supabase.from("holiday_banners").insert(payload).select("id").single<{ id: string }>();

    const { data, error } = await query;

    if (error) {
      throw new Error(error.message);
    }

    await writeAuditLog({
      tableName: "holiday_banners",
      recordId: data.id,
      action: input.id ? "holiday_banner.updated" : "holiday_banner.created",
      newData: payload,
    });

    revalidatePath("/");
    revalidatePath("/admin/banners");

    return { ok: true, message: input.id ? "Banner actualizado correctamente." : "Banner creado correctamente." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo guardar el banner." };
  }
}

export async function toggleHolidayBannerAction(id: string, isActive: boolean): Promise<BannerMutationResult> {
  await requirePermission("settings:manage");
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from("holiday_banners").update({ is_active: isActive, updated_at: new Date().toISOString() }).eq("id", id);

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "holiday_banners",
    recordId: id,
    action: isActive ? "holiday_banner.activated" : "holiday_banner.deactivated",
    newData: { is_active: isActive },
  });

  revalidatePath("/");
  revalidatePath("/admin/banners");
  return { ok: true, message: isActive ? "Banner activado." : "Banner desactivado." };
}

export async function deleteTestHolidayBannerAction(id: string): Promise<BannerMutationResult> {
  await requirePermission("settings:manage");
  const supabase = await getSupabaseServerClient();
  const { data: banner, error: bannerError } = await supabase
    .from("holiday_banners")
    .select("id, title, holiday_key")
    .eq("id", id)
    .maybeSingle<{ id: string; title: string; holiday_key: string | null }>();

  if (bannerError || !banner) {
    return { ok: false, message: bannerError?.message ?? "Banner no encontrado." };
  }

  if (!/test|prueba/i.test(`${banner.title} ${banner.holiday_key ?? ""}`)) {
    return { ok: false, message: "Solo se eliminan banners TEST. Desactiva banners reales para conservar historial." };
  }

  const { error } = await supabase.from("holiday_banners").delete().eq("id", id);

  if (error) {
    return { ok: false, message: error.message };
  }

  await writeAuditLog({
    tableName: "holiday_banners",
    recordId: id,
    action: "holiday_banner.test_deleted",
    oldData: banner,
  });

  revalidatePath("/");
  revalidatePath("/admin/banners");
  return { ok: true, message: "Banner TEST eliminado." };
}

export async function uploadHolidayBannerImageAction(formData: FormData): Promise<BannerMutationResult> {
  await requirePermission("settings:manage");
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Selecciona una imagen para subir." };
  }

  if (!file.type.startsWith("image/")) {
    return { ok: false, message: "El flyer debe ser una imagen." };
  }

  if (file.size > 8 * 1024 * 1024) {
    return { ok: false, message: "La imagen no puede superar 8 MB." };
  }

  const cloudinary = configureCloudinary();
  const buffer = Buffer.from(await file.arrayBuffer());
  const publicId = `banner-${randomUUID()}`;

  try {
    const imageUrl = await new Promise<string>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "car-zone/banners",
          public_id: publicId,
          resource_type: "image",
          overwrite: false,
        },
        (error, uploadResult) => {
          if (error || !uploadResult?.secure_url) {
            reject(error ?? new Error("Cloudinary no devolvio una URL valida."));
            return;
          }

          resolve(uploadResult.secure_url);
        },
      );

      stream.end(buffer);
    });

    return { ok: true, message: "Imagen subida correctamente.", imageUrl };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "No se pudo subir la imagen." };
  }
}
