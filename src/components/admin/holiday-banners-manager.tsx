"use client";

import Image from "next/image";
import { useState, useTransition } from "react";
import {
  deleteTestHolidayBannerAction,
  saveHolidayBannerAction,
  toggleHolidayBannerAction,
  uploadHolidayBannerImageAction,
} from "@/app/admin/banners/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { HolidayBanner, HolidayBannerInput } from "@/types/settings";

type HolidayBannersManagerProps = {
  banners: HolidayBanner[];
};

const emptyBanner: HolidayBannerInput = {
  title: "",
  message: "",
  image_url: "",
  start_date: new Date().toISOString().slice(0, 10),
  end_date: new Date().toISOString().slice(0, 10),
  is_active: true,
  priority: 0,
  button_text: "Ver catalogo",
  button_url: "/catalogo",
};

function fromBanner(banner: HolidayBanner): HolidayBannerInput {
  return {
    id: banner.id,
    title: banner.title,
    message: banner.message,
    image_url: banner.image_url ?? "",
    start_date: banner.start_date,
    end_date: banner.end_date,
    is_active: banner.is_active,
    priority: banner.priority,
    button_text: banner.button_text ?? "",
    button_url: banner.button_url ?? "",
  };
}

function numberValue(value: string) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

export function HolidayBannersManager({ banners }: HolidayBannersManagerProps) {
  const [form, setForm] = useState<HolidayBannerInput>(emptyBanner);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  function update<K extends keyof HolidayBannerInput>(field: K, value: HolidayBannerInput[K]) {
    setForm((current) => ({ ...current, [field]: value }));
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

  function deleteTest(id: string) {
    startTransition(async () => {
      const result = await deleteTestHolidayBannerAction(id);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  async function uploadImage(file: File | null) {
    if (!file) {
      return;
    }

    const formData = new FormData();
    formData.set("file", file);
    const result = await uploadHolidayBannerImageAction(formData);
    if (result.ok && result.imageUrl) {
      update("image_url", result.imageUrl);
      toast.success(result.message);
    } else {
      toast.error(result.message);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[420px_1fr]">
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
          <Field label="Imagen / flyer">
            <Input value={form.image_url} onChange={(event) => update("image_url", event.target.value)} placeholder="https://..." />
            <input
              type="file"
              accept="image/*"
              className="mt-2 text-sm"
              onChange={(event) => uploadImage(event.target.files?.[0] ?? null)}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Fecha inicial">
              <Input type="date" value={form.start_date} onChange={(event) => update("start_date", event.target.value)} />
            </Field>
            <Field label="Fecha final">
              <Input type="date" value={form.end_date} onChange={(event) => update("end_date", event.target.value)} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Prioridad">
              <Input type="number" value={form.priority} onChange={(event) => update("priority", numberValue(event.target.value))} />
            </Field>
            <label className="flex items-center gap-2 pt-6 text-sm">
              <input type="checkbox" checked={form.is_active} onChange={(event) => update("is_active", event.target.checked)} />
              Activo
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
            <Button onClick={save} disabled={isPending} variant="primary">
              {isPending ? "Guardando..." : "Guardar banner"}
            </Button>
            <Button onClick={() => setForm(emptyBanner)} variant="ghost">
              Nuevo
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-black/10 bg-white">
        <div className="border-b border-black/10 p-4">
          <h2 className="font-semibold">Banners configurados</h2>
          <p className="mt-1 text-sm text-black/55">El home muestra el banner activo vigente con mayor prioridad.</p>
        </div>
        <div className="divide-y divide-black/10">
          {banners.length === 0 ? <p className="p-4 text-sm text-black/55">No hay banners.</p> : null}
          {banners.map((banner) => (
            <article key={banner.id} className="grid gap-4 p-4 md:grid-cols-[160px_1fr_auto]">
              <div className="overflow-hidden rounded-md bg-[#f7f7f2]">
                {banner.image_url ? (
                  <Image src={banner.image_url} alt={banner.title} width={320} height={180} className="h-28 w-full object-cover" />
                ) : (
                  <div className="grid h-28 place-items-center text-xs text-black/45">Sin imagen</div>
                )}
              </div>
              <div>
                <p className="font-semibold">{banner.title}</p>
                <p className="mt-1 text-sm text-black/60">{banner.message}</p>
                <p className="mt-2 text-xs text-black/45">
                  {banner.start_date} a {banner.end_date} / prioridad {banner.priority}
                </p>
                <p className={`mt-2 w-fit rounded-md px-2 py-1 text-xs ${banner.is_active ? "bg-[#e8f3f2] text-[#1e5960]" : "bg-[#f7f7f2] text-black/55"}`}>
                  {banner.is_active ? "Activo" : "Inactivo"}
                </p>
              </div>
              <div className="flex flex-wrap items-start gap-2 md:justify-end">
                <Button onClick={() => setForm(fromBanner(banner))} variant="ghost">
                  Editar
                </Button>
                <Button onClick={() => toggle(banner.id, !banner.is_active)} variant="secondary" disabled={isPending}>
                  {banner.is_active ? "Desactivar" : "Activar"}
                </Button>
                {/test|prueba/i.test(`${banner.title} ${banner.holiday_key ?? ""}`) ? (
                  <Button onClick={() => deleteTest(banner.id)} variant="secondary" disabled={isPending}>
                    Eliminar TEST
                  </Button>
                ) : null}
              </div>
            </article>
          ))}
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
