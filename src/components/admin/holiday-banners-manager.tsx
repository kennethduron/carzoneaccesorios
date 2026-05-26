"use client";

import Image from "next/image";
import { useMemo, useState, useTransition } from "react";
import {
  deleteHolidayBannerAction,
  deleteUploadedHolidayBannerMediaAction,
  reviewHolidayBannerIntegrityAction,
  saveHolidayBannerAction,
  toggleHolidayBannerAction,
  updateHolidayBannerPriorityAction,
  uploadHolidayBannerMediaAction,
} from "@/app/admin/banners/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type {
  BannerMediaType,
  BannerSlot,
  BannerStatus,
  HolidayBanner,
  HolidayBannerAuditEntry,
  HolidayBannerInput,
  HolidayBannerStorageSummary,
} from "@/types/settings";
import { getBannerPosterUrl } from "@/utils/image-optimization";

type HolidayBannersManagerProps = {
  banners: HolidayBanner[];
  auditEntries: HolidayBannerAuditEntry[];
  storageSummary: HolidayBannerStorageSummary;
};

const today = new Date().toISOString().slice(0, 10);

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
  image_url: "",
  start_date: today,
  end_date: today,
  is_active: true,
  priority: 1,
  button_text: "Ver catalogo",
  button_url: "/catalogo",
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
    image_url: banner.image_url ?? "",
    start_date: banner.start_date,
    end_date: banner.end_date,
    is_active: banner.is_active,
    priority: banner.priority,
    button_text: banner.button_text ?? "",
    button_url: banner.button_url ?? "",
  };
}

function bytesLabel(bytes: number) {
  if (!bytes) {
    return "Tamano no disponible";
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

export function HolidayBannersManager({ banners, auditEntries, storageSummary }: HolidayBannersManagerProps) {
  const [form, setForm] = useState<HolidayBannerInput>(emptyBanner);
  const [isPending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const toast = useToast();
  const previewUrl = useMemo(() => previewPoster(form), [form]);

  function update<K extends keyof HolidayBannerInput>(field: K, value: HolidayBannerInput[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function changeMediaType(mediaType: BannerMediaType) {
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
      image_url: "",
    }));
  }

  function save() {
    startTransition(async () => {
      const result = await saveHolidayBannerAction(form);
      if (result.ok) {
        toast.success(result.message);
        setForm(emptyBanner);
      } else {
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

  function deleteBanner(id: string) {
    if (!window.confirm("Esto eliminara el banner y su archivo en Cloudinary. Continuar?")) {
      return;
    }

    startTransition(async () => {
      const result = await deleteHolidayBannerAction(id);
      if (result.ok) {
        toast.success(result.message);
        if (form.id === id) {
          setForm(emptyBanner);
        }
      } else {
        toast.error(result.message);
      }
    });
  }

  function reviewIntegrity(deleteOrphans: boolean) {
    startTransition(async () => {
      const result = await reviewHolidayBannerIntegrityAction(deleteOrphans);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  async function uploadMedia(file: File | null) {
    if (!file) {
      return;
    }

    setUploading(true);
    try {
      const previousUnsavedPublicId = !form.id ? form.media_public_id : "";
      const previousUnsavedResourceType = form.media_resource_type;
      const formData = new FormData();
      formData.set("file", file);
      formData.set("mediaType", form.media_type);
      const result = await uploadHolidayBannerMediaAction(formData);

      if (result.ok && result.mediaUrl && result.publicId && result.resourceType && result.mediaType) {
        setForm((current) => ({
          ...current,
          media_type: result.mediaType ?? current.media_type,
          media_url: result.mediaUrl ?? "",
          media_public_id: result.publicId ?? "",
          media_resource_type: result.resourceType ?? current.media_resource_type,
          media_bytes: result.bytes ?? 0,
          media_created_at: result.createdAt ?? "",
          media_format: result.format ?? "",
          media_width: result.width ?? null,
          media_height: result.height ?? null,
          media_duration_seconds: result.durationSeconds ?? null,
          media_thumbnail_url: result.thumbnailUrl ?? "",
          image_url: result.mediaType === "image" ? result.mediaUrl ?? "" : "",
        }));
        if (previousUnsavedPublicId && previousUnsavedPublicId !== result.publicId) {
          await deleteUploadedHolidayBannerMediaAction(previousUnsavedPublicId, previousUnsavedResourceType);
        }
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[440px_1fr]">
      <section className="h-fit rounded-lg border border-black/10 bg-white p-5">
        <h2 className="font-semibold">{form.id ? "Editar banner" : "Nuevo banner"}</h2>
        <div className="mt-4 grid gap-3">
          <Field label="Titulo">
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
            <span className="mb-2 block text-xs font-medium uppercase text-black/50">Ubicacion</span>
            <div className="grid grid-cols-2 gap-2">
              {(["main", "secondary"] as BannerSlot[]).map((slot) => (
                <label
                  key={slot}
                  className={`flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm ${
                    form.banner_slot === slot ? "border-[#e4252c] bg-[#fff1f2]" : "border-black/10 bg-white"
                  }`}
                >
                  <input type="radio" checked={form.banner_slot === slot} onChange={() => update("banner_slot", slot)} />
                  {slotCopy[slot]}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-black/50">Solo puede haber 1 principal y hasta 3 secundarios activos por rango de fechas.</p>
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
              type="file"
              accept={form.media_type === "video" ? "video/mp4,video/webm" : "image/jpeg,image/png,image/webp"}
              className="w-full rounded-md border border-black/10 px-3 py-2 text-sm"
              disabled={uploading || isPending}
              onChange={(event) => uploadMedia(event.target.files?.[0] ?? null)}
            />
            <p className="mt-1 text-xs text-black/50">
              {form.media_type === "video" ? "MP4 o WEBM, maximo 25 MB y 60 segundos." : "JPG, JPEG, PNG o WEBP, maximo 5 MB. Se optimiza a WEBP."}
            </p>
          </Field>

          {form.media_url ? (
            <div className="overflow-hidden rounded-md border border-black/10 bg-[#f4f4f5]">
              {form.media_type === "video" ? (
                <video src={form.media_url} poster={previewUrl || undefined} controls className="aspect-video w-full object-cover" />
              ) : (
                <Image src={form.media_url} alt={form.title || "Preview de banner"} width={900} height={500} className="aspect-video w-full object-cover" />
              )}
              <div className="grid gap-1 border-t border-black/10 bg-white p-3 text-xs text-black/55">
                <span>{bytesLabel(form.media_bytes)}</span>
                {form.media_duration_seconds ? <span>Duracion: {Math.round(form.media_duration_seconds)} segundos</span> : null}
                <span>public_id: {form.media_public_id}</span>
              </div>
            </div>
          ) : null}

          <HomeBannerPreview form={form} posterUrl={previewUrl} />

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
              <Input value={form.button_url} onChange={(event) => update("button_url", event.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={isPending || uploading} variant="primary">
              {isPending ? "Guardando..." : uploading ? "Subiendo..." : "Guardar banner"}
            </Button>
            <Button onClick={() => setForm(emptyBanner)} variant="ghost">
              Nuevo
            </Button>
          </div>
        </div>
      </section>

      <div className="grid gap-5">
        <StorageSummaryPanel summary={storageSummary} />

        <section className="rounded-lg border border-black/10 bg-white">
          <div className="flex flex-col gap-3 border-b border-black/10 p-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="font-semibold">Banners configurados</h2>
              <p className="mt-1 text-sm text-black/55">
                El Home muestra 1 banner principal vigente y hasta 3 secundarios, ordenados por prioridad.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => reviewIntegrity(false)} variant="ghost" disabled={isPending}>
                Revisar integridad
              </Button>
              <Button onClick={() => reviewIntegrity(true)} variant="secondary" disabled={isPending}>
                Limpiar huerfanos
              </Button>
            </div>
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
                    {banner.media_public_id ? <p className="mt-1 break-all text-xs text-black/40">{banner.media_public_id}</p> : null}
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
                    <Button onClick={() => setForm(fromBanner(banner))} variant="ghost">
                      Editar
                    </Button>
                    <Button onClick={() => toggle(banner.id, !banner.is_active)} variant="secondary" disabled={isPending}>
                      {banner.is_active ? "Deshabilitar" : "Habilitar"}
                    </Button>
                    <Button onClick={() => deleteBanner(banner.id)} variant="secondary" disabled={isPending}>
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
    "holiday_banner.created": "Creacion",
    "holiday_banner.updated": "Modificacion",
    "holiday_banner.deleted": "Eliminacion",
    "holiday_banner.activated": "Activacion",
    "holiday_banner.deactivated": "Desactivacion",
    "holiday_banner.priority_updated": "Cambio de prioridad",
    "holiday_banner.integrity_review": "Revision de integridad",
    "holiday_banner.integrity_cleanup": "Limpieza de huerfanos",
  };

  return labels[action] ?? action;
}

function HomeBannerPreview({ form, posterUrl }: { form: HolidayBannerInput; posterUrl: string }) {
  const hasMedia = Boolean(form.media_url);

  return (
    <div>
      <span className="mb-1 block text-xs font-medium uppercase text-black/50">Preview Home</span>
      <div className="overflow-hidden rounded-lg border border-black/10 bg-white shadow-sm">
        <div className="relative bg-[#080808]">
          {hasMedia && form.media_type === "video" ? (
            <video src={form.media_url} poster={posterUrl || undefined} muted loop playsInline controls className="aspect-video w-full object-cover" />
          ) : hasMedia ? (
            <Image src={getBannerPosterUrl(form.media_url)} alt={form.title || "Preview de banner"} width={1400} height={760} className="aspect-video w-full object-cover" />
          ) : (
            <div className="grid aspect-video w-full place-items-center text-sm text-white/55">Vista previa del archivo</div>
          )}
        </div>
        <div className="p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-xl font-semibold">{form.title || "Titulo del banner"}</h3>
              <p className="mt-2 text-sm leading-6 text-black/60">{form.message || "Subtitulo o descripcion promocional visible en Home."}</p>
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
        <Metric label="Imagenes" value={`${summary.imageCount}`} detail={formatBytes(summary.imageBytes)} />
        <Metric label="Videos" value={`${summary.videoCount}`} detail={formatBytes(summary.videoBytes)} />
        <Metric label="Total banners" value={formatBytes(summary.totalBytes)} detail="Segun registros activos e historicos" />
        <Metric
          label="Cloudinary"
          value={summary.cloudinaryUsedBytes !== null ? formatBytes(summary.cloudinaryUsedBytes) : "No disponible"}
          detail={summary.cloudinaryFreeBytes !== null ? `${formatBytes(summary.cloudinaryFreeBytes)} libre estimado` : "Sin datos sensibles"}
        />
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
        <p className="mt-1 text-sm text-black/55">Ultimos movimientos de creacion, cambios, eliminacion e integridad.</p>
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
