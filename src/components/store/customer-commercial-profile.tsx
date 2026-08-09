"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Building2, CheckCircle2, LockKeyhole } from "lucide-react";
import {
  setMyCustomerCommercialFieldOnceAction,
  type CustomerCommercialField,
} from "@/app/cuenta/actions";
import { Input } from "@/components/ui/input";
import { useToast } from "@/contexts/toast-context";

type CommercialFieldDefinition = {
  field: CustomerCommercialField;
  label: string;
  value: string | null;
  help?: string;
  inputMode?: "text" | "numeric";
  maxLength: number;
};

export function CustomerCommercialProfile({
  businessName,
  taxId,
  city,
  enabled,
}: {
  businessName: string | null;
  taxId: string | null;
  city: string | null;
  enabled: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const definitions: CommercialFieldDefinition[] = [
    { field: "businessName", label: "Nombre del negocio", value: businessName, maxLength: 160 },
    { field: "taxId", label: "RTN", value: taxId, maxLength: 40, inputMode: "numeric", help: "14 dígitos; puedes usar espacios o guiones." },
    { field: "city", label: "Ubicación (ciudad/municipio)", value: city, maxLength: 120 },
  ];
  const [drafts, setDrafts] = useState<Record<CustomerCommercialField, string>>({
    businessName: "",
    taxId: "",
    city: "",
  });
  const [errors, setErrors] = useState<Partial<Record<CustomerCommercialField, string>>>({});

  async function requestSave(definition: CommercialFieldDefinition) {
    const value = drafts[definition.field];
    if (!value.trim()) {
      setErrors((current) => ({ ...current, [definition.field]: "Escribe un valor antes de guardar." }));
      return;
    }

    const confirmed = await toast.confirm({
      title: `Confirmar ${definition.label.toLowerCase()}`,
      message: "Después de guardar este dato no podrás editarlo desde tu cuenta.",
      confirmLabel: "Guardar definitivamente",
      cancelLabel: "Revisar",
      tone: "neutral",
    });
    if (!confirmed) return;

    setErrors((current) => ({ ...current, [definition.field]: undefined }));
    startTransition(async () => {
      const result = await setMyCustomerCommercialFieldOnceAction({
        requestKey: crypto.randomUUID(),
        field: definition.field,
        value,
      });
      if (!result.ok) {
        setErrors((current) => ({ ...current, [definition.field]: result.message }));
        toast.error(result.message);
        return;
      }
      toast.success(result.message);
      router.refresh();
    });
  }

  return (
    <section className="mt-5 rounded-lg border border-black/10 bg-white p-5 shadow-sm" aria-labelledby="commercial-profile-title">
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-[#f4f4f5] text-black/70">
          <Building2 size={18} />
        </div>
        <div>
          <h2 id="commercial-profile-title" className="font-semibold">Datos comerciales</h2>
          <p className="mt-1 text-sm text-black/55">
            Completa cada dato vacío cuando lo necesites. Cada campo solo puede guardarse una vez desde tu cuenta.
          </p>
        </div>
      </div>

      {!enabled ? (
        <p className="mt-4 rounded-md bg-[#fff7ed] p-3 text-sm text-[#7c2d12]">
          Verifica tu correo y activa tu cuenta antes de guardar datos comerciales.
        </p>
      ) : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        {definitions.map((definition) => {
          const inputId = `commercial-${definition.field}`;
          const errorId = `${inputId}-error`;
          const helpId = definition.help ? `${inputId}-help` : undefined;
          const describedBy = [helpId, errors[definition.field] ? errorId : null].filter(Boolean).join(" ") || undefined;
          return (
            <div key={definition.field} className="flex min-w-0 flex-col rounded-lg border border-black/10 p-4">
              <label htmlFor={inputId} className="text-sm font-semibold">{definition.label}</label>
              {definition.value ? (
                <>
                  <p className="mt-2 break-words rounded-md bg-[#f4f4f5] px-3 py-3 font-medium">{definition.value}</p>
                  <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-black/55">
                    <LockKeyhole size={15} className="mt-0.5 shrink-0" />
                    Este dato ya fue registrado. Si necesita corregirlo, comuníquese con administración.
                  </p>
                </>
              ) : (
                <>
                  <Input
                    id={inputId}
                    className="mt-2 min-h-11"
                    value={drafts[definition.field]}
                    onChange={(event) => {
                      setDrafts((current) => ({ ...current, [definition.field]: event.target.value }));
                      setErrors((current) => ({ ...current, [definition.field]: undefined }));
                    }}
                    inputMode={definition.inputMode}
                    maxLength={definition.maxLength}
                    disabled={!enabled || pending}
                    aria-describedby={describedBy}
                    aria-invalid={Boolean(errors[definition.field])}
                  />
                  {definition.help ? <p id={helpId} className="mt-1 text-xs text-black/50">{definition.help}</p> : null}
                  <p className="mt-2 text-xs leading-5 text-black/55">
                    Después de guardar este dato no podrás editarlo desde tu cuenta.
                  </p>
                  {errors[definition.field] ? (
                    <p id={errorId} role="alert" className="mt-2 text-sm text-[#9b341b]">{errors[definition.field]}</p>
                  ) : null}
                  <button
                    type="button"
                    className="mt-auto inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-[#080808] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
                    onClick={() => void requestSave(definition)}
                    disabled={!enabled || pending}
                  >
                    <CheckCircle2 size={17} />
                    {pending ? "Guardando…" : `Guardar ${definition.label.toLowerCase()}`}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      <p className="sr-only" aria-live="polite">{pending ? "Guardando dato comercial" : ""}</p>
    </section>
  );
}
