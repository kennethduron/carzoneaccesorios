"use client";

import { useState, useTransition } from "react";
import { Bell, Save } from "lucide-react";
import { saveNotificationSettingsAction } from "@/app/admin/configuracion-fiscal/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { NotificationSettings } from "@/types/notifications";

type NotificationSettingsFormProps = {
  settings: NotificationSettings;
  canEdit: boolean;
};

const fieldClass = "mb-1 block text-xs font-medium uppercase text-black/50";

export function NotificationSettingsForm({ settings, canEdit }: NotificationSettingsFormProps) {
  const [form, setForm] = useState(settings);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  function updateField<K extends keyof NotificationSettings>(field: K, value: NotificationSettings[K]) {
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
      const result = await saveNotificationSettingsAction(form);
      setMessage(result.message);

      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message || "No se pudo guardar la configuración de notificaciones.");
      }
    });
  }

  return (
    <section className="rounded-lg border border-black/10 bg-white p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-[#e8f3f2] text-[#1e5960]">
          <Bell size={18} />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Notificaciones automáticas</h2>
          <p className="mt-1 text-sm text-black/55">
            Correos transaccionales para avisar al dueño o administradores cuando ocurren eventos importantes.
          </p>
        </div>
      </div>

      {!canEdit ? (
        <p className="mb-4 rounded-md bg-[#f7f7f2] p-3 text-sm text-black/60">
          Tu rol puede revisar esta configuración, pero no modificarla.
        </p>
      ) : null}

      <div className="grid gap-4">
        <label>
          <span className={fieldClass}>Correos de notificación</span>
          <Input
            disabled={!canEdit}
            value={form.notification_emails}
            onChange={(event) => updateField("notification_emails", event.target.value)}
            placeholder="admin@carzone.com, dueno@carzone.com"
          />
          <span className="mt-1 block text-xs text-black/50">Separa múltiples correos con coma.</span>
        </label>

        <div className="grid gap-2 sm:grid-cols-3">
          <Toggle
            label="Pedido nuevo"
            checked={form.notify_new_orders}
            disabled={!canEdit}
            onChange={(checked) => updateField("notify_new_orders", checked)}
          />
          <Toggle
            label="Pago confirmado"
            checked={form.notify_payment_confirmed}
            disabled={!canEdit}
            onChange={(checked) => updateField("notify_payment_confirmed", checked)}
          />
          <Toggle
            label="Solicitud mayorista"
            checked={form.notify_wholesale_requests}
            disabled={!canEdit}
            onChange={(checked) => updateField("notify_wholesale_requests", checked)}
          />
        </div>
      </div>

      {canEdit ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={submit} disabled={isPending} variant="dark">
            <Save size={17} />
            {isPending ? "Guardando..." : "Guardar notificaciones"}
          </Button>
          {message ? <p className="text-sm text-black/60">{message}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 rounded-md border border-black/10 bg-[#f7f7f2] px-3 py-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-[#246a73]"
      />
      <span>{label}</span>
    </label>
  );
}
