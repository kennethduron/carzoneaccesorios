"use client";

import { useState, useTransition } from "react";
import { saveCommerceSettingsAction } from "@/app/admin/configuracion-fiscal/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { AdminCompanySettings } from "@/services/supabase/admin-commerce-settings.service";

type CommerceSettingsFormProps = {
  settings: AdminCompanySettings;
  canEdit: boolean;
};

function numberValue(value: string) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function CommerceSettingsForm({ settings, canEdit }: CommerceSettingsFormProps) {
  const [form, setForm] = useState(settings);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  function update<K extends keyof AdminCompanySettings>(field: K, value: AdminCompanySettings[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function save() {
    startTransition(async () => {
      const result = await saveCommerceSettingsAction(form);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <section className="rounded-lg border border-black/10 bg-white p-5 shadow-sm transition-all hover:shadow-md">
      <div className="mb-4">
        <h2 className="font-semibold">Configuración comercial</h2>
        <p className="mt-1 text-sm text-black/55">Envío, pago al recibir, mínimo mayorista, datos BAC y redes sociales.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Envío gratis desde">
          <Input type="number" min={0} step="0.01" value={form.free_shipping_threshold} disabled={!canEdit} onChange={(event) => update("free_shipping_threshold", numberValue(event.target.value))} />
        </Field>
        <Field label="Envío estándar">
          <Input type="number" min={0} step="0.01" value={form.standard_shipping_fee} disabled={!canEdit} onChange={(event) => update("standard_shipping_fee", numberValue(event.target.value))} />
        </Field>
        <Field label="Comisión pago al recibir (%)">
          <Input type="number" min={0} step="0.01" value={form.cash_on_delivery_percentage} disabled={!canEdit} onChange={(event) => update("cash_on_delivery_percentage", numberValue(event.target.value))} />
        </Field>
        <Field label="Mínimo primera compra mayorista">
          <Input type="number" min={0} step="0.01" value={form.first_wholesale_minimum} disabled={!canEdit} onChange={(event) => update("first_wholesale_minimum", numberValue(event.target.value))} />
        </Field>
      </div>

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.enable_cash_on_delivery_fee} disabled={!canEdit} onChange={(event) => update("enable_cash_on_delivery_fee", event.target.checked)} />
        Activar comisión por pago al recibir
      </label>

      <div className="mt-6">
        <h3 className="font-semibold">Datos del comercio para BAC</h3>
        <p className="mt-1 text-sm text-black/55">
          Estos datos se muestran en el footer, páginas legales y servicio al cliente. Revíselos antes de enviarlos a BAC.
        </p>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Field label="Nombre comercial">
          <Input value={form.trade_name} disabled={!canEdit} onChange={(event) => update("trade_name", event.target.value)} />
        </Field>
        <Field label="Razón social">
          <Input value={form.legal_business_name} disabled={!canEdit} onChange={(event) => update("legal_business_name", event.target.value)} />
        </Field>
        <Field label="RTN">
          <Input value={form.business_rtn} disabled={!canEdit} onChange={(event) => update("business_rtn", event.target.value)} />
        </Field>
        <Field label="Dirección">
          <Input value={form.business_address} disabled={!canEdit} onChange={(event) => update("business_address", event.target.value)} />
        </Field>
        <Field label="Teléfono de servicio al cliente">
          <Input value={form.customer_service_phone} disabled={!canEdit} onChange={(event) => update("customer_service_phone", event.target.value)} />
        </Field>
        <Field label="Correo de servicio al cliente">
          <Input type="email" value={form.customer_service_email} disabled={!canEdit} onChange={(event) => update("customer_service_email", event.target.value)} />
        </Field>
        <Field label="WhatsApp de servicio al cliente">
          <Input type="url" value={form.customer_service_whatsapp} disabled={!canEdit} placeholder="https://wa.me/504..." onChange={(event) => update("customer_service_whatsapp", event.target.value)} />
        </Field>
        <Field label="Horario de atención">
          <Input value={form.customer_service_hours} disabled={!canEdit} onChange={(event) => update("customer_service_hours", event.target.value)} />
        </Field>
      </div>

      <div className="mt-6">
        <h3 className="font-semibold">Redes sociales públicas</h3>
        <p className="mt-1 text-sm text-black/55">
          Estos enlaces aparecen en footer, contacto y home. Si un campo queda vacío, no se muestra al cliente.
        </p>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {([
          ["facebook_url", "Facebook"],
          ["instagram_url", "Instagram"],
          ["whatsapp_url", "WhatsApp"],
          ["tiktok_url", "TikTok"],
        ] as const).map(([field, label]) => (
          <Field key={field} label={label}>
            <Input type="url" value={form[field]} disabled={!canEdit} placeholder="https://..." onChange={(event) => update(field, event.target.value)} />
          </Field>
        ))}
      </div>

      <p className="mt-4 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
        Validar tratamiento fiscal de envío y comisión con la contadora. Validar textos legales con asesoría legal antes de producción bancaria final.
      </p>

      {canEdit ? (
        <Button onClick={save} disabled={isPending} variant="primary" className="mt-4">
          {isPending ? "Guardando..." : "Guardar configuración comercial"}
        </Button>
      ) : null}
    </section>
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
