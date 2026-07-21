"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Pencil, Save, ShieldCheck, UserRound, X } from "lucide-react";
import { updateCustomerIdentityAction } from "@/app/admin/crm/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { roleLabels } from "@/lib/auth/roles";
import type { CrmCustomerIdentityInput, CrmCustomerOption, CrmCustomerProfile } from "@/types/crm";
import { formatHnDateTime } from "@/utils/format";

type Props = {
  customer: CrmCustomerOption;
  canEdit: boolean;
  onProfileUpdated: (profile: CrmCustomerProfile) => void;
};

function valueOr(value: string | null | undefined, fallback: string) {
  return value?.trim() || fallback;
}

function identityDraft(customer: CrmCustomerOption): CrmCustomerIdentityInput {
  return {
    customer_id: customer.id,
    business_name: customer.business_name ?? "",
    contact_name: customer.contact_name,
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    tax_id: customer.tax_id ?? "",
    city: customer.city ?? "",
    expected_updated_at: customer.updated_at,
  };
}

export function CustomerIdentitySection({ customer, canEdit, onProfileUpdated }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => identityDraft(customer));
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof CrmCustomerIdentityInput, string>>>({});
  const [isPending, startTransition] = useTransition();
  const submittingRef = useRef(false);
  const toast = useToast();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submittingRef.current) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  function update(field: keyof CrmCustomerIdentityInput, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  }

  function submit() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setFieldErrors({});
    startTransition(async () => {
      try {
        const result = await updateCustomerIdentityAction(draft);
        if (!result.ok) {
          setFieldErrors(result.fieldErrors ?? {});
          toast.error(result.message);
          return;
        }
        if (result.profile) onProfileUpdated(result.profile);
        toast.success(result.message);
        setOpen(false);
        router.refresh();
      } finally {
        submittingRef.current = false;
      }
    });
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-black/10 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#e4252c]">Cliente comercial</p>
            <h3 className="mt-1 font-semibold">Información comercial vigente</h3>
            <p className="mt-1 text-sm text-black/55">Estos datos son independientes de las credenciales de acceso.</p>
          </div>
          {canEdit ? (
            <Button type="button" variant="ghost" onClick={() => { setDraft(identityDraft(customer)); setFieldErrors({}); setOpen(true); }} aria-label="Editar información comercial">
              <Pencil size={16} />
              Editar información
            </Button>
          ) : null}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <IdentityValue label="Nombre comercial" value={valueOr(customer.business_name, "Sin nombre comercial")} />
          <IdentityValue label="Nombre de contacto" value={customer.contact_name} />
          <IdentityValue label="Correo comercial" value={valueOr(customer.email, "Sin correo comercial")} />
          <IdentityValue label="Teléfono comercial" value={valueOr(customer.phone, "Sin teléfono comercial")} />
          <IdentityValue label="RTN" value={valueOr(customer.tax_id, "Sin RTN")} />
          <IdentityValue label="Ciudad" value={valueOr(customer.city, "Sin ciudad")} />
          <IdentityValue label="Estado mayorista" value={customer.is_wholesale ? "Aprobado" : customer.has_wholesale_request ? "Solicitud pendiente" : "No aprobado"} />
          <IdentityValue label="Tipo derivado" value={customer.customer_type === "Retail" ? "Cliente al detalle" : "Mayorista"} />
          <IdentityValue label="Estado CRM" value={customer.lead_status} />
        </div>
      </section>

      <section className="rounded-lg border border-black/10 bg-white p-5">
        <div className="flex items-center gap-2">
          <UserRound size={18} />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-black/45">Cuenta del portal</p>
            <h3 className="font-semibold">Credenciales y estado de acceso</h3>
          </div>
        </div>
        {customer.user_id ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <IdentityValue label="Nombre de cuenta" value={valueOr(customer.account_full_name, "Sin nombre de cuenta")} />
            <IdentityValue label="Correo de acceso" value={valueOr(customer.account_email, "Sin correo de acceso")} />
            <IdentityValue label="Teléfono de cuenta" value={valueOr(customer.account_phone, "Sin teléfono de cuenta")} />
            <IdentityValue label="Rol" value={customer.account_role ? roleLabels[customer.account_role] : "Sin rol"} />
            <IdentityValue label="Estado" value={customer.account_active === false ? "Inactiva" : "Activa"} />
            <IdentityValue label="Fecha de registro" value={customer.account_created_at ? formatHnDateTime(customer.account_created_at) : "No disponible"} />
            <IdentityValue label="Correo confirmado" value={customer.email_confirmed_at ? "Sí" : "No"} />
          </div>
        ) : (
          <div className="mt-4 rounded-md border border-dashed border-black/15 bg-[#f8f8f8] p-4 text-sm text-black/60">
            Este cliente comercial todavía no tiene una cuenta del portal vinculada.
          </div>
        )}
      </section>

      {open ? (
        <div className="cz-layer-modal fixed inset-0 grid place-items-center bg-black/50 p-4" onMouseDown={() => !isPending && setOpen(false)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="customer-identity-title"
            className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="flex items-start justify-between gap-4 border-b border-black/10 p-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[#e4252c]">Cliente comercial</p>
                <h2 id="customer-identity-title" className="mt-1 text-lg font-semibold">Editar información</h2>
                <p className="mt-1 text-sm text-black/55">La cuenta de acceso y el historial no serán modificados.</p>
              </div>
              <button type="button" aria-label="Cerrar edición" disabled={isPending} onClick={() => setOpen(false)} className="grid size-9 place-items-center rounded-md border border-black/10 disabled:opacity-50">
                <X size={17} />
              </button>
            </header>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <IdentityField label="Nombre comercial" value={draft.business_name} error={fieldErrors.business_name} onChange={(value) => update("business_name", value)} />
              <IdentityField label="Nombre de contacto" required value={draft.contact_name} error={fieldErrors.contact_name} onChange={(value) => update("contact_name", value)} />
              <IdentityField label="Correo comercial" type="email" value={draft.email} error={fieldErrors.email} onChange={(value) => update("email", value)} />
              <IdentityField label="Teléfono comercial" type="tel" value={draft.phone} error={fieldErrors.phone} onChange={(value) => update("phone", value)} />
              <IdentityField label="RTN" value={draft.tax_id} error={fieldErrors.tax_id} onChange={(value) => update("tax_id", value)} />
              <IdentityField label="Ciudad" value={draft.city} error={fieldErrors.city} onChange={(value) => update("city", value)} />
            </div>
            <div className="mx-5 flex gap-2 rounded-md bg-[#f4f4f5] p-3 text-xs text-black/60">
              <ShieldCheck className="mt-0.5 shrink-0" size={16} />
              Los cambios quedan auditados. Los campos vacíos se guardan como nulos y no alteran facturas ni pedidos históricos.
            </div>
            <footer className="flex flex-col-reverse gap-2 p-5 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" disabled={isPending} onClick={() => setOpen(false)}>Cancelar</Button>
              <Button type="button" variant="dark" disabled={isPending} onClick={submit}>
                {isPending ? <LoaderCircle className="animate-spin" size={17} /> : <Save size={17} />}
                {isPending ? "Guardando..." : "Guardar cambios"}
              </Button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function IdentityValue({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-[#f4f4f5] p-3"><p className="text-[11px] font-semibold uppercase text-black/45">{label}</p><p className="mt-1 break-words text-sm font-medium">{value}</p></div>;
}

function IdentityField({ label, value, error, required = false, type = "text", onChange }: {
  label: string;
  value: string;
  error?: string;
  required?: boolean;
  type?: "text" | "email" | "tel";
  onChange: (value: string) => void;
}) {
  const id = `customer-identity-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block text-xs font-semibold uppercase text-black/55">{label}{required ? " *" : ""}</span>
      <Input id={id} type={type} value={value} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={(event) => onChange(event.target.value)} />
      {error ? <span id={`${id}-error`} className="mt-1 block text-xs text-[#b91c25]">{error}</span> : null}
    </label>
  );
}
