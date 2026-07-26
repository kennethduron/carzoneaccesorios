"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { ImageIcon, Loader2, Save, Trash2, Upload } from "lucide-react";
import { saveFiscalSettingsAction } from "@/app/admin/configuracion-fiscal/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { FiscalAlert, FiscalSettings } from "@/types/fiscal";
import {
  fiscalLogoAccept,
  fiscalLogoInvalidFormatMessage,
  fiscalLogoMaxBytes,
  fiscalLogoMaxPixels,
  fiscalLogoSavedMessage,
  fiscalLogoTooLargeMessage,
  fiscalLogoTooManyPixelsMessage,
  isAllowedFiscalLogoMimeType,
} from "@/utils/fiscal-logo-rules";

type FiscalSettingsFormProps = {
  settings: FiscalSettings;
  alerts: FiscalAlert[];
  canEdit: boolean;
};

const fieldClass = "mb-1 block text-xs font-medium uppercase text-black/50";

type LogoAction = "keep" | "replace" | "remove";
type LogoFeedbackTone = "neutral" | "success" | "error";

function readImageDimensions(file: File) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new window.Image();

    image.onload = () => {
      const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(dimensions);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Invalid image"));
    };

    image.src = url;
  });
}

export function FiscalSettingsForm({ settings, alerts, canEdit }: FiscalSettingsFormProps) {
  const [form, setForm] = useState(settings);
  const [message, setMessage] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState(settings.logo_url ?? "");
  const [logoAction, setLogoAction] = useState<LogoAction>(settings.logo_url ? "keep" : "remove");
  const [logoFeedback, setLogoFeedback] = useState("");
  const [logoFeedbackTone, setLogoFeedbackTone] = useState<LogoFeedbackTone>("neutral");
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => {
    return () => {
      if (logoPreviewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(logoPreviewUrl);
      }
    };
  }, [logoPreviewUrl]);

  function updateField<K extends keyof FiscalSettings>(field: K, value: FiscalSettings[K]) {
    if (!canEdit) {
      return;
    }
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function selectLogo(file: File | null) {
    if (!canEdit || !file) {
      return;
    }

    if (!isAllowedFiscalLogoMimeType(file.type)) {
      setLogoFeedback(fiscalLogoInvalidFormatMessage);
      setLogoFeedbackTone("error");
      toast.error(fiscalLogoInvalidFormatMessage);
      return;
    }

    if (file.size > fiscalLogoMaxBytes) {
      setLogoFeedback(fiscalLogoTooLargeMessage);
      setLogoFeedbackTone("error");
      toast.error(fiscalLogoTooLargeMessage);
      return;
    }

    try {
      const dimensions = await readImageDimensions(file);
      if (dimensions.width * dimensions.height > fiscalLogoMaxPixels) {
        setLogoFeedback(fiscalLogoTooManyPixelsMessage);
        setLogoFeedbackTone("error");
        toast.error(fiscalLogoTooManyPixelsMessage);
        return;
      }
    } catch {
      setLogoFeedback(fiscalLogoInvalidFormatMessage);
      setLogoFeedbackTone("error");
      toast.error(fiscalLogoInvalidFormatMessage);
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    if (logoPreviewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(logoPreviewUrl);
    }
    setLogoFile(file);
    setLogoPreviewUrl(previewUrl);
    setLogoAction("replace");
    setLogoFeedback("Logo seleccionado. Guarda la configuración para aplicarlo.");
    setLogoFeedbackTone("neutral");
  }

  function removeLogo() {
    if (!canEdit || !logoPreviewUrl) {
      return;
    }

    const confirmed = window.confirm("¿Quieres quitar el logo fiscal? Se eliminará de Cloudinary si pertenece a este proyecto.");
    if (!confirmed) {
      return;
    }

    if (logoPreviewUrl.startsWith("blob:")) {
      URL.revokeObjectURL(logoPreviewUrl);
    }
    setLogoFile(null);
    setLogoPreviewUrl("");
    setLogoAction("remove");
    setLogoFeedback("Logo marcado para quitar. Guarda la configuración para confirmar.");
    setLogoFeedbackTone("neutral");
  }

  function buildFiscalFormData() {
    const formData = new FormData();
    formData.set("legal_name", form.legal_name);
    formData.set("rtn", form.rtn);
    formData.set("cai", form.cai);
    formData.set("invoice_range_start", form.invoice_range_start);
    formData.set("invoice_range_end", form.invoice_range_end);
    formData.set("current_invoice_number", form.current_invoice_number);
    formData.set("cai_authorization_date", form.cai_authorization_date ?? "");
    formData.set("emission_deadline", form.emission_deadline ?? "");
    formData.set("fiscal_address", form.fiscal_address);
    formData.set("phone", form.phone);
    formData.set("email", form.email);
    formData.set("logo_action", logoAction);

    if (logoAction === "replace" && logoFile) {
      formData.set("logo_file", logoFile);
    }

    return formData;
  }

  function submit() {
    if (!canEdit) {
      return;
    }
    startTransition(async () => {
      const result = await saveFiscalSettingsAction(buildFiscalFormData());
      setMessage(result.message);
      if (result.ok) {
        const savedLogoUrl = result.logoUrl ?? null;
        if (logoPreviewUrl.startsWith("blob:")) {
          URL.revokeObjectURL(logoPreviewUrl);
        }
        setForm((current) => ({ ...current, logo_url: savedLogoUrl }));
        setLogoFile(null);
        setLogoPreviewUrl(savedLogoUrl ?? "");
        setLogoAction(savedLogoUrl ? "keep" : "remove");
        setLogoFeedback(savedLogoUrl ? fiscalLogoSavedMessage : "Logo fiscal quitado correctamente.");
        setLogoFeedbackTone("success");
        toast.success(result.message || "Configuración fiscal guardada correctamente.");
      } else {
        setLogoFeedback(result.message);
        setLogoFeedbackTone("error");
        toast.error(result.message || "No se pudo guardar la configuración fiscal.");
      }
    });
  }

  return (
    <div className="space-y-5">
      {alerts.length > 0 ? (
        <div className="grid gap-2">
          {alerts.map((alert) => (
            <p
              key={alert.message}
              className={`rounded-md p-3 text-sm font-medium ${
                alert.type === "danger" ? "bg-[#fff0ea] text-[#9b341b]" : "bg-[#fff8df] text-[#7a5417]"
              }`}
            >
              {alert.message}
            </p>
          ))}
        </div>
      ) : null}

      <section className="rounded-lg border border-black/10 bg-white p-5">
        {!canEdit ? (
          <p className="mb-4 rounded-md bg-[#f4f4f5] p-3 text-sm text-black/60">
            Tu rol puede revisar CAI, RTN, rangos fiscales y alertas, pero no modificar esta configuración.
          </p>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          <Field label="Nombre legal de la empresa">
            <Input disabled={!canEdit} value={form.legal_name} onChange={(event) => updateField("legal_name", event.target.value)} />
          </Field>
          <Field label="RTN de la empresa">
            <Input disabled={!canEdit} value={form.rtn} onChange={(event) => updateField("rtn", event.target.value)} />
          </Field>
          <Field label="CAI">
            <Input disabled={!canEdit} value={form.cai} onChange={(event) => updateField("cai", event.target.value)} />
          </Field>
          <Field label="Fecha de autorización del CAI">
            <Input
              type="date"
              disabled={!canEdit}
              value={form.cai_authorization_date ?? ""}
              onChange={(event) => updateField("cai_authorization_date", event.target.value || null)}
            />
          </Field>
          <Field label="Fecha límite de emisión">
            <Input
              type="date"
              disabled={!canEdit}
              value={form.emission_deadline ?? ""}
              onChange={(event) => updateField("emission_deadline", event.target.value || null)}
            />
          </Field>
          <Field label="Rango inicial de facturación">
            <Input
              disabled={!canEdit}
              value={form.invoice_range_start}
              onChange={(event) => updateField("invoice_range_start", event.target.value)}
            />
          </Field>
          <Field label="Rango final de facturación">
            <Input
              disabled={!canEdit}
              value={form.invoice_range_end}
              onChange={(event) => updateField("invoice_range_end", event.target.value)}
            />
          </Field>
          <Field label="Número actual de factura">
            <Input
              disabled={!canEdit}
              value={form.current_invoice_number}
              onChange={(event) => updateField("current_invoice_number", event.target.value)}
            />
          </Field>
          <Field label="Teléfono">
            <Input disabled={!canEdit} value={form.phone} onChange={(event) => updateField("phone", event.target.value)} />
          </Field>
          <Field label="Correo electrónico">
            <Input disabled={!canEdit} type="email" value={form.email} onChange={(event) => updateField("email", event.target.value)} />
          </Field>
          <label className="lg:col-span-2">
            <span className={fieldClass}>Dirección fiscal</span>
            <textarea
              value={form.fiscal_address}
              disabled={!canEdit}
              onChange={(event) => updateField("fiscal_address", event.target.value)}
              className="min-h-28 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c]"
            />
          </label>
        </div>

        <section className="mt-5 border-t border-black/10 pt-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h3 className="text-base font-semibold">Logo de la empresa</h3>
              <p className="mt-1 text-sm text-black/55">Este logo aparecerá en las facturas fiscales.</p>
              <p className="mt-1 text-xs text-black/45">PNG, JPG o WEBP. Maximo 5 MB y 5 megapixeles.</p>
            </div>
            {canEdit ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" disabled={isPending} onClick={() => fileInputRef.current?.click()}>
                  <Upload size={17} />
                  Subir logo
                </Button>
                {logoPreviewUrl ? (
                  <Button type="button" variant="ghost" disabled={isPending} onClick={removeLogo}>
                    <Trash2 size={17} />
                    Quitar logo
                  </Button>
                ) : null}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={fiscalLogoAccept}
                  className="hidden"
                  onChange={(event) => {
                    selectLogo(event.target.files?.[0] ?? null);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
            ) : null}
          </div>

          <div className="mt-4 flex min-h-32 items-center justify-center rounded-md border border-dashed border-black/20 bg-[#f4f4f5] p-4">
            {logoPreviewUrl ? (
              <Image
                src={logoPreviewUrl}
                alt="Logo fiscal de la empresa"
                width={260}
                height={120}
                unoptimized={logoPreviewUrl.startsWith("blob:") || logoPreviewUrl.includes("res.cloudinary.com")}
                className="max-h-28 w-auto max-w-full object-contain"
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-sm text-black/45">
                <ImageIcon size={24} />
                No hay logo fiscal configurado.
              </div>
            )}
          </div>

          {logoFeedback ? (
            <p
              className={`mt-3 rounded-md px-3 py-2 text-sm ${
                logoFeedbackTone === "error"
                  ? "bg-[#fff2ed] text-[#9b341b]"
                  : logoFeedbackTone === "success"
                    ? "bg-[#ecfdf5] text-[#166534]"
                    : "bg-white text-black/60"
              }`}
            >
              {logoFeedback}
            </p>
          ) : null}
        </section>

        {canEdit ? (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button onClick={submit} disabled={isPending} variant="dark">
              {isPending ? <Loader2 size={17} className="animate-spin" /> : <Save size={17} />}
              {isPending ? "Guardando..." : "Guardar configuración"}
            </Button>
            {message ? <p className="text-sm text-black/60">{message}</p> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label>
      <span className={fieldClass}>{label}</span>
      {children}
    </label>
  );
}


