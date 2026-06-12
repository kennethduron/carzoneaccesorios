"use client";

import Image from "next/image";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  createHolidayBannerMediaTokenAction,
  deleteHolidayBannerAction,
  deleteUploadedHolidayBannerMediaAction,
  reviewHolidayBannerIntegrityAction,
  saveTechnicalAlertSettingsAction,
  saveHolidayBannerAction,
  toggleHolidayBannerAction,
  updateHolidayBannerPriorityAction,
} from "@/app/admin/banners/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type {
  BannerMediaType,
  BannerResourceType,
  BannerSlot,
  BannerStatus,
  HolidayBanner,
  HolidayBannerAuditEntry,
  HolidayBannerInput,
  HolidayBannerStorageSummary,
  TechnicalAlertSettings,
} from "@/types/settings";
import { getBannerPosterUrl } from "@/utils/image-optimization";

type HolidayBannersManagerProps = {
  banners: HolidayBanner[];
  auditEntries: HolidayBannerAuditEntry[];
  storageSummary: HolidayBannerStorageSummary | null;
  technicalAlertSettings: TechnicalAlertSettings | null;
  canViewTechnical: boolean;
};

type CloudinarySignatureResponse =
  | {
      ok: true;
      apiKey: string;
      cloudName: string;
      signature: string;
      params: Record<string, string>;
      folder: string;
      resourceType: BannerResourceType;
      uploadUrl: string;
    }
  | {
      ok: false;
      message: string;
    };

type CloudinaryUploadResponse = {
  public_id?: string;
  secure_url?: string;
  resource_type?: string;
  bytes?: number;
  created_at?: string;
  format?: string;
  width?: number;
  height?: number;
  duration?: number;
  eager?: Array<{ secure_url?: string; format?: string; bytes?: number; width?: number; height?: number }>;
  error?: { message?: string };
};

const today = new Date().toISOString().slice(0, 10);
const defaultButtonText = "Ver catálogo";
const defaultButtonUrl = "/catalogo";
const imageMaxBytes = 5 * 1024 * 1024;
const videoMaxBytes = 25 * 1024 * 1024;
const videoMaxDurationSeconds = 60;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const allowedImageExtensions = new Set(["jpg", "jpeg", "png", "webp"]);
const allowedVideoTypes = new Set(["video/mp4", "video/webm"]);
const allowedVideoExtensions = new Set(["mp4", "webm"]);

const emptyBanner: HolidayBannerInput = {
  title: "",
  message: "",
  banner_slot: "main",
  media_type: "image",
  media_url: "",
  media_public_id: "",
  media_resource_type: "image",
  media_bytes: 0,
  media_created_at: "",
  media_format: "",
  media_width: null,
  media_height: null,
  media_duration_seconds: null,
  media_thumbnail_url: "",
  media_asset_token: "",
  image_url: "",
  start_date: today,
  end_date: today,
  is_active: true,
  priority: 1,
  button_text: defaultButtonText,
  button_url: defaultButtonUrl,
};

const statusCopy: Record<BannerStatus, { label: string; className: string }> = {
  active: { label: "Activo", className: "bg-emerald-50 text-emerald-700" },
  scheduled: { label: "Programado", className: "bg-sky-50 text-sky-700" },
  expired: { label: "Expirado", className: "bg-zinc-100 text-zinc-600" },
  disabled: { label: "Deshabilitado", className: "bg-amber-50 text-amber-700" },
};

const slotCopy: Record<BannerSlot, string> = {
  main: "Principal",
  secondary: "Secundario",
};

function fromBanner(banner: HolidayBanner): HolidayBannerInput {
  return {
    id: banner.id,
    title: banner.title,
    message: banner.message,
    banner_slot: banner.banner_slot,
    media_type: banner.media_type,
    media_url: banner.media_url ?? banner.image_url ?? "",
    media_public_id: banner.media_public_id ?? "",
    media_resource_type: banner.media_resource_type,
    media_bytes: banner.media_bytes ?? 0,
    media_created_at: banner.media_created_at ?? "",
    media_format: banner.media_format ?? "",
    media_width: banner.media_width,
    media_height: banner.media_height,
    media_duration_seconds: banner.media_duration_seconds,
    media_thumbnail_url: banner.media_thumbnail_url ?? "",
    media_asset_token: "",
    image_url: banner.image_url ?? "",
    start_date: banner.start_date,
    end_date: banner.end_date,
    is_active: banner.is_active,
    priority: banner.priority,
    button_text: banner.button_text ?? defaultButtonText,
    button_url: banner.button_url ?? defaultButtonUrl,
  };
}

function bytesLabel(bytes: number) {
  if (!bytes) {
    return "Tamaño no disponible";
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function numberValue(value: string) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 1;
}

function previewPoster(form: HolidayBannerInput) {
  if (form.media_thumbnail_url) {
    return form.media_thumbnail_url;
  }

  if (form.media_type === "image" && form.media_url) {
    return getBannerPosterUrl(form.media_url);
  }

  return "";
}

function fileExtension(file: File) {
  const name = file.name.toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1) : "";
}

function validateSelectedMediaFile(file: File, mediaType: BannerMediaType) {
  const extension = fileExtension(file);
  const mimeType = file.type.toLowerCase();

  if (mediaType === "video") {
    if (!allowedVideoTypes.has(mimeType) || !allowedVideoExtensions.has(extension)) {
      return "Solo se permiten videos MP4 o WEBM.";
    }

    if (file.size > videoMaxBytes) {
      return "El video supera 25 MB.";
    }

    return "";
  }

  if (!allowedImageTypes.has(mimeType) || !allowedImageExtensions.has(extension)) {
    return "Formato no permitido. Usa JPG, JPEG, PNG o WEBP.";
  }

  if (file.size > imageMaxBytes) {
    return "La imagen no puede superar 5 MB.";
  }

  return "";
}

function readVideoDuration(previewUrl: string) {
  return new Promise<number | null>((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      const duration = Number(video.duration);
      resolve(Number.isFinite(duration) ? duration : null);
    };
    video.onerror = () => resolve(null);
    video.src = previewUrl;
  });
}

function withButtonDefaults(input: HolidayBannerInput): HolidayBannerInput {
  return {
    ...input,
    button_text: input.button_text.trim() || defaultButtonText,
    button_url: input.button_url.trim() || defaultButtonUrl,
  };
}

function cloudinaryErrorMessage(mediaType: BannerMediaType) {
  return mediaType === "video" ? "No se pudo subir el video. Intenta nuevamente." : "No se pudo subir la imagen. Intenta nuevamente.";
}

async function requestCloudinarySignature(file: File, mediaType: BannerMediaType) {
  const response = await fetch("/api/admin/banners/cloudinary-signature", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mediaType,
      fileName: file.name,
      fileType: file.type,
      fileSize: file.size,
    }),
  });
  const payload = (await response.json().catch(() => ({ ok: false, message: "No se pudo preparar la subida." }))) as CloudinarySignatureResponse;

  if (!response.ok || !payload.ok) {
    throw new Error(payload.ok ? "No se pudo preparar la subida." : payload.message);
  }

  return payload;
}

async function uploadFileToCloudinary(file: File, signature: Extract<CloudinarySignatureResponse, { ok: true }>) {
  const formData = new FormData();
  formData.set("file", file);
  formData.set("api_key", signature.apiKey);
  formData.set("signature", signature.signature);

  for (const [key, value] of Object.entries(signature.params)) {
    formData.set(key, value);
  }

  const response = await fetch(signature.uploadUrl, {
    method: "POST",
    body: formData,
  });
  const payload = (await response.json().catch(() => ({ error: { message: "Cloudinary no devolvio una respuesta valida." } }))) as CloudinaryUploadResponse;

  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message || "Cloudinary no pudo subir el archivo.");
  }

  return payload;
}

function directUploadMediaUrl(mediaType: BannerMediaType, upload: CloudinaryUploadResponse) {
  if (mediaType === "video") {
    return upload.eager?.find((item) => item.format === "mp4" && item.secure_url)?.secure_url ?? upload.secure_url ?? "";
  }

  return upload.secure_url ?? "";
}

function directUploadThumbnailUrl(mediaType: BannerMediaType, upload: CloudinaryUploadResponse) {
  if (mediaType === "video") {
    return upload.eager?.find((item) => item.format === "jpg" && item.secure_url)?.secure_url ?? "";
  }

  return upload.secure_url ?? "";
}

export function HolidayBannersManager({ banners, auditEntries, storageSummary, technicalAlertSettings, canViewTechnical }: HolidayBannersManagerProps) {
  const [form, setForm] = useState<HolidayBannerInput>(emptyBanner);
  const [alertSettings, setAlertSettings] = useState<TechnicalAlertSettings | null>(technicalAlertSettings);
  const [isPending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [selectedMediaFile, setSelectedMediaFile] = useState<File | null>(null);
  const [selectedMediaPreviewUrl, setSelectedMediaPreviewUrl] = useState("");
  const [selectedMediaError, setSelectedMediaError] = useState("");
  const [bannerToDelete, setBannerToDelete] = useState<HolidayBanner | null>(null);
  const [mediaInputKey, setMediaInputKey] = useState(0);
  const toast = useToast();
  const posterUrl = useMemo(() => (selectedMediaPreviewUrl ? "" : previewPoster(form)), [form, selectedMediaPreviewUrl]);
  const mediaPreviewUrl = selectedMediaPreviewUrl || form.media_url;

  useEffect(() => {
    return () => {
      if (selectedMediaPreviewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(selectedMediaPreviewUrl);
      }
    };
  }, [selectedMediaPreviewUrl]);

  function update<K extends keyof HolidayBannerInput>(field: K, value: HolidayBannerInput[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function clearSelectedMediaFile() {
    if (selectedMediaPreviewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(selectedMediaPreviewUrl);
    }
    setSelectedMediaFile(null);
    setSelectedMediaPreviewUrl("");
    setSelectedMediaError("");
    setUploadStatus("");
    setMediaInputKey((current) => current + 1);
  }

  function resetForm() {
    clearSelectedMediaFile();
    setForm(emptyBanner);
  }

  function clearUploadedMediaReferences(assetToken: string) {
    setForm((current) => {
      if (current.media_asset_token !== assetToken) {
        return current;
      }

      return {
        ...current,
        media_url: "",
        media_public_id: "",
        media_bytes: 0,
        media_created_at: "",
        media_format: "",
        media_width: null,
        media_height: null,
        media_duration_seconds: null,
        media_thumbnail_url: "",
        media_asset_token: "",
        image_url: "",
      };
    });
  }

  function editBanner(banner: HolidayBanner) {
    clearSelectedMediaFile();
    setForm(fromBanner(banner));
  }

  function changeMediaType(mediaType: BannerMediaType) {
    clearSelectedMediaFile();
    setForm((current) => ({
      ...current,
      media_type: mediaType,
      media_resource_type: mediaType,
      media_url: "",
      media_public_id: "",
      media_bytes: 0,
      media_created_at: "",
      media_format: "",
      media_width: null,
      media_height: null,
      media_duration_seconds: null,
      media_thumbnail_url: "",
      media_asset_token: "",
      image_url: "",
    }));
  }

  async function selectMediaFile(file: File | null) {
    if (!file) {
      clearSelectedMediaFile();
      return;
    }

    const nextPreviewUrl = URL.createObjectURL(file);
    if (selectedMediaPreviewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(selectedMediaPreviewUrl);
    }

    const validationMessage = validateSelectedMediaFile(file, form.media_type);
    setSelectedMediaFile(file);
    setSelectedMediaPreviewUrl(nextPreviewUrl);
    setSelectedMediaError(validationMessage);
    setUploadStatus("");
    setForm((current) => ({
      ...current,
      media_bytes: file.size,
      media_format: fileExtension(file),
      media_duration_seconds: current.media_type === "video" ? null : current.media_duration_seconds,
    }));

    if (form.media_type === "video" && !validationMessage) {
      const duration = await readVideoDuration(nextPreviewUrl);
      if (duration !== null) {
        setForm((current) => ({ ...current, media_duration_seconds: duration }));
        if (duration > videoMaxDurationSeconds) {
          setSelectedMediaError("El video supera 60 segundos.");
        }
      }
    }
  }

  async function uploadSelectedMedia(input: HolidayBannerInput): Promise<{ input: HolidayBannerInput; uploadedToken: string } | null> {
    if (!selectedMediaFile) {
      return { input, uploadedToken: "" };
    }

    const validationMessage = selectedMediaError || validateSelectedMediaFile(selectedMediaFile, input.media_type);
    if (validationMessage) {
      toast.error(validationMessage);
      return null;
    }

    setUploading(true);
    setUploadStatus(input.media_type === "video" ? "Subiendo video a Cloudinary..." : "Subiendo imagen a Cloudinary...");
    try {
      const signature = await requestCloudinarySignature(selectedMediaFile, input.media_type);
      const upload = await uploadFileToCloudinary(selectedMediaFile, signature);
      const publicId = upload.public_id ?? "";
      const resourceType = upload.resource_type === "video" ? "video" : "image";

      if (!publicId) {
        toast.error(cloudinaryErrorMessage(input.media_type));
        return null;
      }

      setUploadStatus("Validando archivo subido...");
      const result = await createHolidayBannerMediaTokenAction({
        mediaType: input.media_type,
        resourceType,
        publicId,
        secureUrl: directUploadMediaUrl(input.media_type, upload),
        bytes: upload.bytes ?? selectedMediaFile.size,
        createdAt: upload.created_at ?? "",
        format: upload.format ?? fileExtension(selectedMediaFile),
        width: upload.width ?? null,
        height: upload.height ?? null,
        durationSeconds: upload.duration ?? input.media_duration_seconds ?? null,
        thumbnailUrl: directUploadThumbnailUrl(input.media_type, upload),
      });

      if (!result.ok || !result.mediaUrl || !result.assetToken || !result.mediaType) {
        toast.error(result.message || cloudinaryErrorMessage(input.media_type));
        return null;
      }

      const nextInput: HolidayBannerInput = {
        ...input,
        media_type: result.mediaType,
        media_url: result.mediaUrl,
        media_public_id: "",
        media_resource_type: result.mediaType,
        media_bytes: result.bytes ?? selectedMediaFile.size,
        media_created_at: result.createdAt ?? "",
        media_format: result.format ?? fileExtension(selectedMediaFile),
        media_width: result.width ?? null,
        media_height: result.height ?? null,
        media_duration_seconds: result.durationSeconds ?? null,
        media_thumbnail_url: result.thumbnailUrl ?? "",
        media_asset_token: result.assetToken,
        image_url: result.mediaType === "image" ? result.mediaUrl : "",
      };

      setForm(nextInput);
      clearSelectedMediaFile();
      return { input: nextInput, uploadedToken: result.assetToken };
    } catch (error) {
      toast.error(error instanceof Error ? error.message : cloudinaryErrorMessage(input.media_type));
      return null;
    } finally {
      setUploading(false);
      setUploadStatus("");
    }
  }

  function save() {
    startTransition(async () => {
      const prepared = await uploadSelectedMedia(withButtonDefaults(form));
      if (!prepared) {
        return;
      }

      const result = await saveHolidayBannerAction(prepared.input);
      if (result.ok) {
        toast.success(result.message);
        resetForm();
      } else {
        if (prepared.uploadedToken) {
          await deleteUploadedHolidayBannerMediaAction(prepared.uploadedToken);
          clearUploadedMediaReferences(prepared.uploadedToken);
        }
        toast.error(result.message);
      }
    });
  }

  function toggle(id: string, isActive: boolean) {
    startTransition(async () => {
      const result = await toggleHolidayBannerAction(id, isActive);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function updatePriority(id: string, priority: number) {
    startTransition(async () => {
      const result = await updateHolidayBannerPriorityAction(id, priority);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function confirmDeleteBanner() {
    if (!bannerToDelete) return;
    const id = bannerToDelete.id;
    startTransition(async () => {
      const result = await deleteHolidayBannerAction(id);
      if (result.ok) {
        toast.success(result.message);
        if (form.id === id) {
          resetForm();
        }
        setBannerToDelete(null);
      } else {
        toast.error(result.message);
      }
    });
  }

  function reviewIntegrity(deleteOrphans: boolean) {
    if (!canViewTechnical) {
      toast.error("Esta acción solo está disponible para administración técnica.");
      return;
    }

    startTransition(async () => {
      const result = await reviewHolidayBannerIntegrityAction(deleteOrphans);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function saveAlertSettings() {
    if (!alertSettings) {
      return;
    }

    startTransition(async () => {
      const result = await saveTechnicalAlertSettingsAction(alertSettings);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[440px_1fr]">
      <section className="h-fit rounded-lg border border-black/10 bg-white p-5">
        <h2 className="font-semibold">{form.id ? "Editar banner" : "Nuevo banner"}</h2>
        <div className="mt-4 grid gap-3">
          <Field label="Título">
            <Input value={form.title} onChange={(event) => update("title", event.target.value)} />
          </Field>
          <Field label="Mensaje">
            <textarea
              value={form.message}
              onChange={(event) => update("message", event.target.value)}
              className="min-h-24 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
            />
          </Field>

          <div>
            <span className="mb-2 block text-xs font-medium uppercase text-black/50">Ubicación</span>
            <div className="grid grid-cols-2 gap-2">
              {(["main", "secondary"] as BannerSlot[]).map((slot) => (
                <label
                  key={slot}
                  className={`flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm ${
                    form.banner_slot === slot ? "border-[#e4252c] bg-[#fff1f2]" : "border-black/10 bg-white"
                  }`}
                >
                  <input type="radio" checked={form.banner_slot === slot} onChange={() => update("banner_slot", slot)} />
                  <span>
                    <span className="block font-medium">{slotCopy[slot]}</span>
                    <span className="mt-0.5 block text-xs leading-4 text-black/55">
                      {slot === "main"
                        ? "Banner principal: aparece como el banner más importante del inicio. Solo puede haber 1 banner principal activo por fecha."
                        : "Banner secundario: aparece como promoción adicional. Puedes tener hasta 3 secundarios activos por fecha."}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-black/50">Usa Principal para la promoción más importante y Secundario para ofertas adicionales.</p>
          </div>

          <div>
            <span className="mb-2 block text-xs font-medium uppercase text-black/50">Tipo de banner</span>
            <div className="grid grid-cols-2 gap-2">
              <label className={`flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm ${form.media_type === "image" ? "border-[#e4252c] bg-[#fff1f2]" : "border-black/10 bg-white"}`}>
                <input type="radio" checked={form.media_type === "image"} onChange={() => changeMediaType("image")} />
                Imagen
              </label>
              <label className={`flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm ${form.media_type === "video" ? "border-[#e4252c] bg-[#fff1f2]" : "border-black/10 bg-white"}`}>
                <input type="radio" checked={form.media_type === "video"} onChange={() => changeMediaType("video")} />
                Video
              </label>
            </div>
          </div>

          <Field label={form.media_type === "video" ? "Subir video" : "Subir imagen"}>
            <input
              key={mediaInputKey}
              type="file"
              accept={form.media_type === "video" ? "video/mp4,video/webm" : "image/jpeg,image/png,image/webp"}
              className="w-full rounded-md border border-black/10 px-3 py-2 text-sm"
              disabled={uploading || isPending}
              onChange={(event) => void selectMediaFile(event.target.files?.[0] ?? null)}
            />
            <p className="mt-1 text-xs text-black/50">
              {form.media_type === "video" ? "MP4 o WEBM, máximo 25 MB y 60 segundos." : "JPG, JPEG, PNG o WEBP, máximo 5 MB. Se optimiza a WEBP."}
            </p>
            {selectedMediaFile ? (
              <p className="mt-1 text-xs text-black/55">
                Archivo listo para guardar: {selectedMediaFile.name}. {uploadStatus || "Se subira directamente a Cloudinary al guardar el banner."}
              </p>
            ) : null}
            {selectedMediaError ? <p className="mt-1 text-xs font-medium text-[#e4252c]">{selectedMediaError}</p> : null}
          </Field>

          {mediaPreviewUrl ? (
            <div className="overflow-hidden rounded-md border border-black/10 bg-[#f4f4f5]">
              {form.media_type === "video" ? (
                <video src={mediaPreviewUrl} poster={posterUrl || undefined} controls className="aspect-video w-full object-cover">
                  Tu navegador no puede reproducir este video.
                </video>
              ) : (
                <BannerImagePreview src={mediaPreviewUrl} alt={form.title || "Preview de banner"} />
              )}
              <div className="grid gap-1 border-t border-black/10 bg-white p-3 text-xs text-black/55">
                <span>{bytesLabel(form.media_bytes)}</span>
                {form.media_duration_seconds ? <span>Duración: {Math.round(form.media_duration_seconds)} segundos</span> : null}
                {canViewTechnical && form.media_public_id ? <span>public_id: {form.media_public_id}</span> : null}
              </div>
            </div>
          ) : null}

          <HomeBannerPreview form={form} mediaUrl={mediaPreviewUrl} posterUrl={posterUrl} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Fecha de inicio">
              <Input type="date" value={form.start_date} onChange={(event) => update("start_date", event.target.value)} />
            </Field>
            <Field label="Fecha de finalizacion">
              <Input type="date" value={form.end_date} onChange={(event) => update("end_date", event.target.value)} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Prioridad">
              <select
                value={form.priority}
                onChange={(event) => update("priority", numberValue(event.target.value))}
                className="h-11 w-full rounded-md border border-black/10 bg-white px-3 text-sm outline-none"
              >
                {[1, 2, 3, 4, 5].map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-black/50">1 aparece primero. 5 aparece después. Si solo tienes un banner, deja 1.</p>
            </Field>
            <label className="flex items-center gap-2 pt-6 text-sm">
              <input type="checkbox" checked={form.is_active} onChange={(event) => update("is_active", event.target.checked)} />
              Habilitado
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Texto boton">
              <Input value={form.button_text} onChange={(event) => update("button_text", event.target.value)} />
            </Field>
            <Field label="URL boton">
              <Input
                value={form.button_url}
                onChange={(event) => update("button_url", event.target.value)}
                onBlur={(event) => {
                  if (!event.target.value.trim()) {
                    update("button_url", defaultButtonUrl);
                  }
                }}
              />
              <p className="mt-1 text-xs text-black/50">Recomendado: /catalogo para enviar al cliente al catálogo de productos.</p>
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={isPending || uploading || Boolean(selectedMediaError)} variant="primary">
              {isPending ? "Guardando..." : uploading ? "Subiendo..." : "Guardar banner"}
            </Button>
            <Button onClick={resetForm} variant="ghost">
              Nuevo
            </Button>
          </div>
        </div>
      </section>

      <div className="grid gap-5">
        {canViewTechnical && storageSummary ? (
          <>
            <StorageSummaryPanel summary={storageSummary} />
            {alertSettings ? (
              <TechnicalAlertsPanel settings={alertSettings} onChange={setAlertSettings} onSave={saveAlertSettings} disabled={isPending} />
            ) : null}
          </>
        ) : null}

        <section className="rounded-lg border border-black/10 bg-white">
          <div className="flex flex-col gap-3 border-b border-black/10 p-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="font-semibold">Banners configurados</h2>
              <p className="mt-1 text-sm text-black/55">
                La página de inicio muestra un banner principal vigente y hasta tres secundarios, ordenados por prioridad.
              </p>
            </div>
            {canViewTechnical ? (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => reviewIntegrity(false)} variant="ghost" disabled={isPending}>
                  Revisar integridad
                </Button>
                <Button onClick={() => reviewIntegrity(true)} variant="secondary" disabled={isPending}>
                  Limpiar huérfanos
                </Button>
              </div>
            ) : null}
          </div>
          <div className="divide-y divide-black/10">
            {banners.length === 0 ? <p className="p-4 text-sm text-black/55">No hay banners.</p> : null}
            {banners.map((banner) => {
              const status = statusCopy[banner.status];
              const mediaUrl = banner.media_url ?? banner.image_url;
              const poster = banner.media_thumbnail_url || (mediaUrl && banner.media_type === "image" ? getBannerPosterUrl(mediaUrl) : "");

              return (
                <article key={banner.id} className="grid gap-4 p-4 lg:grid-cols-[180px_1fr_auto]">
                  <div className="overflow-hidden rounded-md bg-[#f4f4f5]">
                    {mediaUrl ? (
                      banner.media_type === "video" ? (
                        <video src={mediaUrl} poster={poster || undefined} muted playsInline preload="metadata" className="h-28 w-full object-cover" />
                      ) : (
                        <Image src={mediaUrl} alt={banner.title} width={360} height={205} className="h-28 w-full object-cover" />
                      )
                    ) : (
                      <div className="grid h-28 place-items-center text-xs text-black/45">Sin archivo</div>
                    )}
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{banner.title}</p>
                      <span className={`rounded-md px-2 py-1 text-xs ${status.className}`}>{status.label}</span>
                      <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs text-black/55">{slotCopy[banner.banner_slot]}</span>
                      <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs text-black/55">
                        {banner.media_type === "video" ? "Video" : "Imagen"}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-black/60">{banner.message}</p>
                    <p className="mt-2 text-xs text-black/45">
                      {banner.start_date} a {banner.end_date} / prioridad {banner.priority} / {bytesLabel(banner.media_bytes)}
                    </p>
                    {canViewTechnical && banner.media_public_id ? <p className="mt-1 break-all text-xs text-black/40">{banner.media_public_id}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-start gap-2 lg:justify-end">
                    <select
                      value={banner.priority}
                      onChange={(event) => updatePriority(banner.id, numberValue(event.target.value))}
                      className="h-10 rounded-md border border-black/10 bg-white px-2 text-sm"
                      disabled={isPending}
                      aria-label={`Prioridad de ${banner.title}`}
                    >
                      {[1, 2, 3, 4, 5].map((priority) => (
                        <option key={priority} value={priority}>
                          {priority}
                        </option>
                      ))}
                    </select>
                    <Button onClick={() => editBanner(banner)} variant="ghost">
                      Editar
                    </Button>
                    <Button onClick={() => toggle(banner.id, !banner.is_active)} variant="secondary" disabled={isPending}>
                      {banner.is_active ? "Deshabilitar" : "Habilitar"}
                    </Button>
                    <Button onClick={() => setBannerToDelete(banner)} variant="secondary" disabled={isPending}>
                      Eliminar
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <BannerAuditPanel entries={auditEntries} />
      </div>
      {bannerToDelete ? (
        <DeleteBannerModal
          banner={bannerToDelete}
          isPending={isPending}
          onClose={() => setBannerToDelete(null)}
          onConfirm={confirmDeleteBanner}
        />
      ) : null}
    </div>
  );
}

function DeleteBannerModal({
  banner,
  isPending,
  onConfirm,
  onClose,
}: {
  banner: HolidayBanner;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="cz-layer-modal fixed inset-0 overflow-y-auto bg-black/45 p-3 sm:p-4">
      <section className="mx-auto my-4 max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-4 text-[#080808] shadow-xl sm:my-10 sm:p-5">
        <div className="border-b border-black/10 pb-4">
          <p className="text-sm font-semibold text-[#b91c25]">Eliminar banner</p>
          <h2 className="mt-1 text-2xl font-semibold">{banner.title}</h2>
        </div>
        <p className="mt-4 text-sm text-black/65">
          ¿Estás seguro de que deseas eliminar este banner? Esta acción no se puede deshacer.
        </p>
        <div className="mt-4 grid gap-2 rounded-md bg-[#f4f4f5] p-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium uppercase text-black/45">Tipo</p>
            <p className="font-medium">{banner.media_type === "video" ? "Video" : "Imagen"}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase text-black/45">Estado</p>
            <p className="font-medium">{banner.is_active ? "Activo" : "Inactivo"}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost" disabled={isPending}>
            Cancelar
          </Button>
          <Button onClick={onConfirm} variant="secondary" disabled={isPending}>
            {isPending ? "Eliminando..." : "Eliminar banner"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label>
      <span className="mb-1 block text-xs font-medium uppercase text-black/50">{label}</span>
      {children}
    </label>
  );
}

function formatBytes(bytes: number | null) {
  if (!bytes) {
    return "0 MB";
  }

  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("es-HN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function auditActionLabel(action: string) {
  const labels: Record<string, string> = {
    "holiday_banner.created": "Creación",
    "holiday_banner.updated": "Modificación",
    "holiday_banner.deleted": "Eliminación",
    "holiday_banner.activated": "Activacion",
    "holiday_banner.deactivated": "Desactivacion",
    "holiday_banner.priority_updated": "Cambio de prioridad",
    "holiday_banner.integrity_review": "Revisión de integridad",
    "holiday_banner.integrity_cleanup": "Limpieza de huérfanos",
    "holiday_banner.cloudinary_asset_deleted": "Archivo técnico eliminado",
    "technical_alert.cloudinary_storage_sent": "Alerta técnica enviada",
    "technical_alert.cloudinary_storage_failed": "Alerta técnica fallida",
    "technical_alert_settings.updated": "Configuración técnica actualizada",
  };

  return labels[action] ?? action;
}

function BannerImagePreview({ src, alt }: { src: string; alt: string }) {
  if (src.startsWith("blob:")) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} className="aspect-video w-full object-cover" />;
  }

  return <Image src={src} alt={alt} width={900} height={500} className="aspect-video w-full object-cover" />;
}

function HomeBannerPreview({ form, mediaUrl, posterUrl }: { form: HolidayBannerInput; mediaUrl: string; posterUrl: string }) {
  const hasMedia = Boolean(mediaUrl);

  return (
    <div>
      <span className="mb-1 block text-xs font-medium uppercase text-black/50">Vista previa de la página de inicio</span>
      <div className="overflow-hidden rounded-lg border border-black/10 bg-white shadow-sm">
        <div className="relative bg-[#080808]">
          {hasMedia && form.media_type === "video" ? (
            <video src={mediaUrl} poster={posterUrl || undefined} muted loop playsInline controls className="aspect-video w-full object-cover">
              Tu navegador no puede reproducir este video.
            </video>
          ) : hasMedia ? (
            mediaUrl.startsWith("blob:") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mediaUrl} alt={form.title || "Preview de banner"} className="aspect-video w-full object-cover" />
            ) : (
              <Image src={getBannerPosterUrl(mediaUrl)} alt={form.title || "Preview de banner"} width={1400} height={760} className="aspect-video w-full object-cover" />
            )
          ) : (
            <div className="grid aspect-video w-full place-items-center text-sm text-white/55">Vista previa del archivo</div>
          )}
        </div>
        <div className="p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-xl font-semibold">{form.title || "Título del banner"}</h3>
              <p className="mt-2 text-sm leading-6 text-black/60">{form.message || "Subtítulo o descripción promocional visible en la página de inicio."}</p>
            </div>
            {form.button_text ? (
              <span className="inline-flex min-h-10 shrink-0 items-center justify-center rounded-md bg-[#e4252c] px-4 text-sm font-semibold text-white">
                {form.button_text}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function StorageSummaryPanel({ summary }: { summary: HolidayBannerStorageSummary }) {
  const usedPercent =
    summary.cloudinaryUsedBytes !== null && summary.cloudinaryLimitBytes
      ? Math.min(100, Math.round((summary.cloudinaryUsedBytes / summary.cloudinaryLimitBytes) * 100))
      : null;

  return (
    <section className="rounded-lg border border-black/10 bg-white p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold">Uso de almacenamiento</h2>
          <p className="mt-1 text-sm text-black/55">
            Metricas administrativas de banners. {summary.source === "cloudinary" ? "Incluye uso total reportado por Cloudinary." : "Cloudinary no reporto cuota; se muestra el registro local."}
          </p>
        </div>
        {usedPercent !== null ? <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs text-black/60">{usedPercent}% usado</span> : null}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Imágenes" value={`${summary.imageCount}`} detail={formatBytes(summary.imageBytes)} />
        <Metric label="Videos" value={`${summary.videoCount}`} detail={formatBytes(summary.videoBytes)} />
        <Metric label="Total de banners" value={formatBytes(summary.totalBytes)} detail="Según los registros activos e históricos" />
        <Metric
          label="Cloudinary"
          value={summary.cloudinaryUsedBytes !== null ? formatBytes(summary.cloudinaryUsedBytes) : "No disponible"}
          detail={summary.cloudinaryFreeBytes !== null ? `${formatBytes(summary.cloudinaryFreeBytes)} libre estimado` : "Sin datos sensibles"}
        />
      </div>
    </section>
  );
}

function TechnicalAlertsPanel({
  settings,
  onChange,
  onSave,
  disabled,
}: {
  settings: TechnicalAlertSettings;
  onChange: (settings: TechnicalAlertSettings) => void;
  onSave: () => void;
  disabled: boolean;
}) {
  return (
    <section className="rounded-lg border border-black/10 bg-white p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold">Alertas técnicas</h2>
          <p className="mt-1 text-sm text-black/55">Configuración visible solo para la administración técnica.</p>
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.enabled} onChange={(event) => onChange({ ...settings, enabled: event.target.checked })} />
          Activas
        </label>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_180px_auto]">
        <Field label="Correo electrónico técnico">
          <Input value={settings.email} onChange={(event) => onChange({ ...settings, email: event.target.value })} />
        </Field>
        <Field label="Umbral Cloudinary">
          <Input
            type="number"
            min={1}
            max={100}
            value={settings.cloudinaryStorageThresholdPercent}
            onChange={(event) =>
              onChange({ ...settings, cloudinaryStorageThresholdPercent: Math.min(100, Math.max(1, numberValue(event.target.value))) })
            }
          />
        </Field>
        <div className="flex items-end">
          <Button onClick={onSave} disabled={disabled} variant="secondary">
            Guardar alertas
          </Button>
        </div>
      </div>
      <p className="mt-3 rounded-md bg-zinc-100 px-3 py-2 text-xs text-black/60">
        Cuenta técnica de servicios: {settings.serviceAccountEmail}. Uso interno para copias de seguridad, tareas programadas, proveedores y futuras integraciones.
      </p>

      <div className="mt-3 flex flex-wrap gap-2 text-xs text-black/50">
        <span className="rounded-md bg-zinc-100 px-2 py-1">
          Última comprobación: {settings.lastCheckedAt ? formatDateTime(settings.lastCheckedAt) : "Sin registro"}
        </span>
        <span className="rounded-md bg-zinc-100 px-2 py-1">
          Ultima alerta: {settings.lastAlertSentAt ? formatDateTime(settings.lastAlertSentAt) : "Sin registro"}
        </span>
      </div>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-md border border-black/10 bg-[#f8f8f8] p-3">
      <p className="text-xs font-medium uppercase text-black/45">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      <p className="mt-1 text-xs text-black/50">{detail}</p>
    </div>
  );
}

function BannerAuditPanel({ entries }: { entries: HolidayBannerAuditEntry[] }) {
  return (
    <section className="rounded-lg border border-black/10 bg-white">
      <div className="border-b border-black/10 p-4">
        <h2 className="font-semibold">Historial de banners</h2>
        <p className="mt-1 text-sm text-black/55">Últimos movimientos de creación, modificación y eliminación.</p>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        {entries.length === 0 ? <p className="p-4 text-sm text-black/55">No hay movimientos registrados.</p> : null}
        <div className="divide-y divide-black/10">
          {entries.map((entry) => (
            <article key={entry.id} className="grid gap-1 p-4 text-sm sm:grid-cols-[1fr_auto]">
              <div>
                <p className="font-medium">{auditActionLabel(entry.action)}</p>
                <p className="mt-1 text-black/58">
                  {entry.banner_title || "Banner"} / {entry.media_type === "video" ? "video" : "imagen"} / {entry.actor_name}
                  {entry.actor_role ? ` (${entry.actor_role})` : ""}
                </p>
              </div>
              <time className="text-xs text-black/45 sm:text-right">{formatDateTime(entry.created_at)}</time>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
