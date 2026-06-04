import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { getSessionProfile } from "@/lib/auth/session";
import { configureCloudinary } from "@/lib/cloudinary";
import type { BannerMediaType, BannerResourceType } from "@/types/settings";

export const dynamic = "force-dynamic";

const bannerFolder = "car-zone/banners";
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowedImageExtensions = new Set(["jpg", "jpeg", "png", "webp"]);
const allowedVideoTypes = new Set(["video/mp4", "video/webm"]);
const allowedVideoExtensions = new Set(["mp4", "webm"]);
const imageMaxBytes = 5 * 1024 * 1024;
const videoMaxBytes = 25 * 1024 * 1024;

type SignatureRequest = {
  mediaType?: unknown;
  fileName?: unknown;
  fileType?: unknown;
  fileSize?: unknown;
};

function normalizeMediaType(value: unknown): BannerMediaType {
  return value === "video" ? "video" : "image";
}

function fileExtension(fileName: unknown) {
  const name = String(fileName ?? "").toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1) : "";
}

function validateRequest(input: SignatureRequest, mediaType: BannerMediaType) {
  const extension = fileExtension(input.fileName);
  const mimeType = String(input.fileType ?? "").toLowerCase();
  const fileSize = Number(input.fileSize ?? 0);

  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return mediaType === "video" ? "Selecciona un video antes de guardar." : "Selecciona una imagen antes de guardar.";
  }

  if (mediaType === "video") {
    if (!allowedVideoTypes.has(mimeType) || !allowedVideoExtensions.has(extension)) {
      return "Solo se permiten videos MP4 o WEBM.";
    }

    if (fileSize > videoMaxBytes) {
      return "El video supera 25 MB.";
    }

    return "";
  }

  if (!allowedImageTypes.has(mimeType) || !allowedImageExtensions.has(extension)) {
    return "Formato no permitido. Usa JPG, JPEG, PNG o WEBP.";
  }

  if (fileSize > imageMaxBytes) {
    return "La imagen no puede superar 5 MB.";
  }

  return "";
}

function cloudinaryParams(input: SignatureRequest, mediaType: BannerMediaType, actorId: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const publicId = `${mediaType}-${randomUUID()}`;
  const params: Record<string, string> = {
    timestamp,
    folder: bannerFolder,
    public_id: publicId,
    overwrite: "false",
    invalidate: "true",
    context: [
      "source=holiday_banner_admin",
      `actor_id=${actorId}`,
      `original_bytes=${Math.trunc(Number(input.fileSize ?? 0))}`,
    ].join("|"),
  };

  if (mediaType === "video") {
    params.eager = "w_1600,c_limit,q_auto,f_mp4|w_900,h_500,c_fill,g_auto,q_auto,f_jpg,so_0";
    params.eager_async = "false";
  }

  return params;
}

export async function POST(request: NextRequest) {
  const profile = await getSessionProfile();

  if (!profile) {
    return NextResponse.json({ ok: false, message: "No tienes permiso para subir banners." }, { status: 401 });
  }

  if (!hasEffectivePermission(profile.role, profile.permissions, "commercial_settings:manage", profile.email)) {
    return NextResponse.json({ ok: false, message: "No tienes permiso para subir banners." }, { status: 403 });
  }

  let input: SignatureRequest;
  try {
    input = (await request.json()) as SignatureRequest;
  } catch {
    return NextResponse.json({ ok: false, message: "Solicitud invalida." }, { status: 400 });
  }

  const mediaType = normalizeMediaType(input.mediaType);
  const resourceType: BannerResourceType = mediaType;
  const validationMessage = validateRequest(input, mediaType);

  if (validationMessage) {
    return NextResponse.json({ ok: false, message: validationMessage }, { status: 400 });
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return NextResponse.json({ ok: false, message: "Cloudinary no esta configurado para banners." }, { status: 500 });
  }

  const cloudinary = configureCloudinary();
  const params = cloudinaryParams(input, mediaType, profile.id);
  const signature = cloudinary.utils.api_sign_request(params, apiSecret);

  return NextResponse.json({
    ok: true,
    apiKey,
    cloudName,
    signature,
    params,
    folder: bannerFolder,
    resourceType,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
  });
}
