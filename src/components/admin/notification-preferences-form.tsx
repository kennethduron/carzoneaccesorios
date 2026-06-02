"use client";

import { useMemo, useState, useTransition } from "react";
import { BellRing, Save } from "lucide-react";
import { saveNotificationPreferenceAction, saveUserNotificationPreferenceAction } from "@/app/admin/configuracion/actions";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { canRoleReceiveNotificationType } from "@/lib/notifications/accountant-scope";
import type { AppRole } from "@/types/auth";
import type { NotificationPreference, NotificationUserPreference } from "@/types/notifications";

type Props = {
  preferences: NotificationPreference[];
  userPreferences: NotificationUserPreference[];
  currentRole: AppRole;
  canManageGlobal: boolean;
};

const availableRoles: Array<{ value: AppRole; label: string }> = [
  { value: "technical_owner", label: "Technical owner" },
  { value: "business_owner", label: "Business owner" },
  { value: "admin", label: "Admin" },
  { value: "contadora", label: "Contadora" },
  { value: "bodega", label: "Bodega" },
  { value: "vendedor", label: "Vendedor" },
  { value: "soporte", label: "Soporte" },
];

export function NotificationPreferencesForm({ preferences, userPreferences, currentRole, canManageGlobal }: Props) {
  const [items, setItems] = useState(preferences);
  const [personalItems, setPersonalItems] = useState(() => mergePersonalPreferences(preferences, userPreferences, currentRole));
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingPersonalType, setSavingPersonalType] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
  const grouped = useMemo(() => {
    return items.reduce<Record<string, NotificationPreference[]>>((groups, item) => {
      const key = currentRole === "contadora" ? accountantPreferenceGroup(item.notification_type) : item.module;
      groups[key] = [...(groups[key] ?? []), item];
      return groups;
    }, {});
  }, [currentRole, items]);

  function update(id: string, changes: Partial<NotificationPreference>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  }

  function updatePersonal(type: string, changes: Partial<PersonalPreference>) {
    setPersonalItems((current) => current.map((item) => (item.notification_type === type ? { ...item, ...changes } : item)));
  }

  function toggleRole(item: NotificationPreference, role: AppRole) {
    if (!canRoleReceiveNotificationType(role, item.notification_type)) {
      return;
    }

    const roles = new Set(item.destination_roles);
    if (roles.has(role)) {
      roles.delete(role);
    } else {
      roles.add(role);
    }
    update(item.id, { destination_roles: [...roles] });
  }

  function save(item: NotificationPreference) {
    setSavingId(item.id);
    startTransition(async () => {
      const result = await saveNotificationPreferenceAction({
        id: item.id,
        internal_enabled: item.internal_enabled,
        email_enabled: item.email_enabled,
        push_enabled: item.push_enabled,
        destination_roles: item.destination_roles,
        frequency: item.frequency,
      });
      setSavingId(null);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function savePersonal(item: PersonalPreference) {
    setSavingPersonalType(item.notification_type);
    startTransition(async () => {
      const result = await saveUserNotificationPreferenceAction({
        notification_type: item.notification_type,
        internal_enabled: item.internal_enabled,
        email_enabled: item.email_enabled,
        push_enabled: item.push_enabled,
        frequency: item.frequency,
      });
      setSavingPersonalType(null);
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  if (items.length === 0) {
    return null;
  }

  return (
    <section className="space-y-4 rounded-lg border border-black/10 bg-white p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-[#fff1f2] text-[#b91c25]">
          <BellRing size={18} />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Notificaciones</h2>
          <p className="mt-1 text-sm text-black/55">
            Ajusta alertas internas, correos y push para ahorrar correo sin perder avisos importantes.
          </p>
        </div>
      </div>

      <div className="rounded-md border border-black/10 bg-[#fafafa] p-3">
        <h3 className="mb-3 text-sm font-semibold uppercase text-black/55">Mis preferencias</h3>
        <div className="grid gap-3">
          {personalItems.map((item) => (
            <div key={item.notification_type} className="rounded-md border border-black/10 bg-white p-3">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="font-semibold">{item.label}</p>
                  <p className="text-xs text-black/45">
                    {currentRole === "contadora" ? accountantPreferenceGroup(item.notification_type) : item.module} · {item.notification_type}
                  </p>
                </div>
                {item.email_required ? (
                  <span className="w-fit rounded-full bg-[#fff1f2] px-2.5 py-1 text-xs font-semibold text-[#b91c25]">
                    Obligatorio
                  </span>
                ) : null}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-4">
                <Switch label="Interna" checked={item.internal_enabled} disabled={false} onChange={(value) => updatePersonal(item.notification_type, { internal_enabled: value })} />
                <Switch label="Correo" checked={item.email_enabled} disabled={item.email_required} onChange={(value) => updatePersonal(item.notification_type, { email_enabled: value })} />
                <Switch label="Push" checked={item.push_enabled} disabled={false} onChange={(value) => updatePersonal(item.notification_type, { push_enabled: value })} />
                <label className="grid gap-1 text-sm">
                  <span className="text-xs font-medium uppercase text-black/45">Frecuencia</span>
                  <select
                    value={item.frequency}
                    onChange={(event) => updatePersonal(item.notification_type, { frequency: event.target.value as PersonalPreference["frequency"] })}
                    className="rounded-md border border-black/10 bg-white px-3 py-2"
                  >
                    <option value="immediate">Inmediata</option>
                    <option value="hourly">Cada hora</option>
                    <option value="daily">Diaria</option>
                    <option value="weekly">Semanal</option>
                    <option value="manual">Manual</option>
                  </select>
                </label>
              </div>
              <div className="mt-3">
                <Button onClick={() => savePersonal(item)} disabled={isPending && savingPersonalType === item.notification_type} variant="dark">
                  <Save size={16} />
                  {isPending && savingPersonalType === item.notification_type ? "Guardando..." : "Guardar mis preferencias"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {canManageGlobal ? (
      <div className="grid gap-4">
        <h3 className="text-sm font-semibold uppercase text-black/55">Reglas por rol</h3>
        {Object.entries(grouped).map(([module, moduleItems]) => (
          <div key={module} className="rounded-md border border-black/10 bg-[#fafafa] p-3">
            <h3 className="mb-3 text-sm font-semibold uppercase text-black/55">{module}</h3>
            <div className="grid gap-3">
              {moduleItems.map((item) => {
                const canEdit = canManageGlobal && (currentRole === "technical_owner" || !item.technical_only);
                return (
                  <div key={item.id} className="rounded-md border border-black/10 bg-white p-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <p className="font-semibold">{item.label}</p>
                        <p className="text-xs text-black/45">{item.notification_type}</p>
                      </div>
                      {item.technical_only ? (
                        <span className="w-fit rounded-full bg-black px-2.5 py-1 text-xs font-semibold text-white">Tecnica</span>
                      ) : null}
                    </div>

                    <div className="mt-3 grid gap-2 sm:grid-cols-4">
                      <Switch
                        label="Interna"
                        checked={item.internal_enabled}
                        disabled={!canEdit}
                        onChange={(value) => update(item.id, { internal_enabled: value })}
                      />
                      <Switch
                        label="Correo"
                        checked={item.email_enabled}
                        disabled={!canEdit}
                        onChange={(value) => update(item.id, { email_enabled: value })}
                      />
                      <Switch
                        label="Push futuro"
                        checked={item.push_enabled}
                        disabled={!canEdit}
                        onChange={(value) => update(item.id, { push_enabled: value })}
                      />
                      <label className="grid gap-1 text-sm">
                        <span className="text-xs font-medium uppercase text-black/45">Frecuencia</span>
                        <select
                          value={item.frequency}
                          disabled={!canEdit}
                          onChange={(event) => update(item.id, { frequency: event.target.value as NotificationPreference["frequency"] })}
                          className="rounded-md border border-black/10 bg-white px-3 py-2 disabled:bg-[#f4f4f5]"
                        >
                          <option value="immediate">Inmediata</option>
                          <option value="hourly">Cada hora</option>
                          <option value="daily">Diaria</option>
                          <option value="weekly">Semanal</option>
                          <option value="manual">Manual</option>
                        </select>
                      </label>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {availableRoles
                        .filter((role) =>
                          (currentRole === "technical_owner" || role.value !== "technical_owner") &&
                          canRoleReceiveNotificationType(role.value, item.notification_type),
                        )
                        .map((role) => (
                          <label key={role.value} className="flex items-center gap-2 rounded-full border border-black/10 px-3 py-1.5 text-xs">
                            <input
                              type="checkbox"
                              disabled={!canEdit}
                              checked={item.destination_roles.includes(role.value)}
                              onChange={() => toggleRole(item, role.value)}
                              className="accent-[#e4252c]"
                            />
                            {role.label}
                          </label>
                        ))}
                    </div>

                    {canEdit ? (
                      <div className="mt-3">
                        <Button onClick={() => save(item)} disabled={isPending && savingId === item.id} variant="dark">
                          <Save size={16} />
                          {isPending && savingId === item.id ? "Guardando..." : "Guardar"}
                        </Button>
                      </div>
                    ) : (
                      <p className="mt-3 rounded-md bg-[#f4f4f5] p-2 text-xs text-black/55">
                        Solo technical_owner puede modificar esta preferencia.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      ) : null}
    </section>
  );
}

type PersonalPreference = Pick<
  NotificationPreference,
  "notification_type" | "module" | "label" | "internal_enabled" | "email_enabled" | "push_enabled" | "frequency" | "email_required"
>;

function mergePersonalPreferences(preferences: NotificationPreference[], overrides: NotificationUserPreference[], currentRole: AppRole): PersonalPreference[] {
  const overrideByType = new Map(overrides.map((item) => [item.notification_type, item]));

  return preferences.map((preference) => {
    const override = overrideByType.get(preference.notification_type);
    const defaultEmailEnabled = currentRole === "bodega" ? false : preference.email_enabled;
    return {
      notification_type: preference.notification_type,
      module: preference.module,
      label: preference.label,
      internal_enabled: override?.internal_enabled ?? preference.internal_enabled,
      email_enabled: preference.email_required ? true : (override?.email_enabled ?? defaultEmailEnabled),
      push_enabled: override?.push_enabled ?? preference.push_enabled,
      frequency: override?.frequency ?? preference.frequency,
      email_required: preference.email_required,
    };
  });
}

function accountantPreferenceGroup(notificationType: string) {
  if (notificationType.startsWith("invoice.")) {
    return "Facturas";
  }

  if (notificationType.includes("cai")) {
    return "CAI";
  }

  if (notificationType.includes("range") || notificationType.includes("correlative")) {
    return "Rangos fiscales";
  }

  if (notificationType.includes("error")) {
    return "Errores fiscales";
  }

  return "Reportes fiscales";
}

function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-black/10 bg-[#f4f4f5] px-3 py-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-[#e4252c]"
      />
      {label}
    </label>
  );
}
