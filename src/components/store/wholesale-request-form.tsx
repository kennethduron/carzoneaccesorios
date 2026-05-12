"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Building2, Loader2, Send } from "lucide-react";
import { submitWholesaleRequestAction } from "@/app/contacto/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";

const initialForm = {
  businessName: "",
  contactName: "",
  phone: "",
  email: "",
  city: "",
  taxId: "",
  comment: "",
};

export function WholesaleRequestForm() {
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  function updateField(field: keyof typeof initialForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");

    startTransition(async () => {
      const result = await submitWholesaleRequestAction(form);
      setMessage(result.message);

      if (result.ok) {
        toast.success(result.message);
        setForm(initialForm);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <section id="mayoreo" className="rounded-lg border border-black/10 bg-white p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-[#e8f3f2] text-[#1e5960]">
          <Building2 size={18} />
        </div>
        <div>
          <h2 className="font-semibold">Solicitar cuenta mayorista</h2>
          <p className="mt-1 text-sm text-black/60">
            Envia tus datos para que el equipo revise y apruebe tu acceso. Registrarte como cliente regular no activa precios mayoristas.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Nombre del negocio">
          <Input
            value={form.businessName}
            onChange={(event) => updateField("businessName", event.target.value)}
            placeholder="Ej. Repuestos López"
            required
          />
        </Field>
        <Field label="Nombre de contacto">
          <Input
            value={form.contactName}
            onChange={(event) => updateField("contactName", event.target.value)}
            placeholder="Nombre y apellido"
            required
          />
        </Field>
        <Field label="Teléfono">
          <Input
            value={form.phone}
            onChange={(event) => updateField("phone", event.target.value)}
            placeholder="Ej. 99999999"
            required
          />
        </Field>
        <Field label="Correo">
          <Input
            type="email"
            value={form.email}
            onChange={(event) => updateField("email", event.target.value)}
            placeholder="compras@negocio.com"
            required
          />
        </Field>
        <Field label="Ciudad">
          <Input
            value={form.city}
            onChange={(event) => updateField("city", event.target.value)}
            placeholder="San Pedro Sula"
            required
          />
        </Field>
        <Field label="RTN si aplica">
          <Input value={form.taxId} onChange={(event) => updateField("taxId", event.target.value)} placeholder="Opcional" />
        </Field>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs font-medium uppercase text-black/50">Comentario</span>
          <textarea
            value={form.comment}
            onChange={(event) => updateField("comment", event.target.value)}
            placeholder="Cuéntanos qué productos compras, volumen aproximado o datos útiles para aprobar tu cuenta."
            className="min-h-28 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
          />
        </label>

        {message ? <p className="rounded-md bg-[#f7f7f2] px-3 py-2 text-sm text-black/65 sm:col-span-2">{message}</p> : null}

        <div className="sm:col-span-2">
          <Button type="submit" variant="dark" disabled={isPending} className="w-full sm:w-auto">
            {isPending ? <Loader2 className="animate-spin" size={17} /> : <Send size={17} />}
            {isPending ? "Enviando solicitud..." : "Enviar solicitud mayorista"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase text-black/50">{label}</span>
      {children}
    </label>
  );
}
