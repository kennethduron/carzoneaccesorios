"use client";

import { useState, useTransition } from "react";
import { Save } from "lucide-react";
import { saveFiscalSettingsAction } from "@/app/admin/configuracion-fiscal/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { FiscalAlert, FiscalSettings } from "@/types/fiscal";

type FiscalSettingsFormProps = {
  settings: FiscalSettings;
  alerts: FiscalAlert[];
  canEdit: boolean;
};

const fieldClass = "mb-1 block text-xs font-medium uppercase text-black/50";

export function FiscalSettingsForm({ settings, alerts, canEdit }: FiscalSettingsFormProps) {
  const [form, setForm] = useState(settings);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  function updateField<K extends keyof FiscalSettings>(field: K, value: FiscalSettings[K]) {
    if (!canEdit) {
      return;
    }
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submit() {
    if (!canEdit) {
      return;
    }
    startTransition(async () => {
      const result = await saveFiscalSettingsAction(form);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message || "Configuración fiscal guardada correctamente.");
      } else {
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
          <Field label="Logo">
            <Input
              disabled={!canEdit}
              value={form.logo_url ?? ""}
              onChange={(event) => updateField("logo_url", event.target.value || null)}
              placeholder="https://res.cloudinary.com/..."
            />
          </Field>
          <Field label="Teléfono">
            <Input disabled={!canEdit} value={form.phone} onChange={(event) => updateField("phone", event.target.value)} />
          </Field>
          <Field label="Correo">
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

        {canEdit ? (
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button onClick={submit} disabled={isPending} variant="dark">
              <Save size={17} />
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


