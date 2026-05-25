"use client";

import Link from "next/link";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { Building2, CheckCircle2, Loader2, LogIn, Send, X } from "lucide-react";
import { getWholesaleAccessStateAction } from "@/app/actions/wholesale";
import { submitWholesaleRequestAction } from "@/app/contacto/actions";
import { WholesaleAccountRequestCard } from "@/components/store/wholesale-account-request-card";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { WholesaleAccessState } from "@/types/wholesale";

const initialForm = {
  businessName: "",
  contactName: "",
  phone: "",
  email: "",
  city: "",
  taxId: "",
  comment: "",
};

export function WholesaleRequestForm({ initialAccessState = null }: { initialAccessState?: WholesaleAccessState | null }) {
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState("");
  const [successOpen, setSuccessOpen] = useState(false);
  const [accessState, setAccessState] = useState<WholesaleAccessState | null>(initialAccessState);
  const [accessReady, setAccessReady] = useState(Boolean(initialAccessState));
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  useEffect(() => {
    if (initialAccessState) {
      return undefined;
    }

    let active = true;

    getWholesaleAccessStateAction().then((state) => {
      if (active) {
        setAccessState(state);
        setAccessReady(true);
      }
    });

    return () => {
      active = false;
    };
  }, [initialAccessState]);

  function updateField(field: keyof typeof initialForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");

    startTransition(async () => {
      const result = await submitWholesaleRequestAction(form);
      const displayMessage = result.ok
        ? "Recibimos tu solicitud. Nuestro equipo revisará tu cuenta y te notificaremos cuando tengas acceso a precios mayoristas."
        : result.message;
      setMessage(displayMessage);

      if (result.ok) {
        toast.notify({
          title: "Solicitud mayorista enviada",
          message: displayMessage,
          type: "success",
          duration: 7000,
        });
        setForm(initialForm);
        setSuccessOpen(true);
      } else {
        toast.error(displayMessage);
      }
    });
  }

  if (!accessReady) {
    return (
      <section id="mayoreo" className="rounded-lg border border-black/10 bg-white p-5">
        <div className="flex items-center gap-3 text-sm text-black/60">
          <Loader2 size={17} className="animate-spin text-[#e4252c]" />
          Revisando tu cuenta...
        </div>
      </section>
    );
  }

  if (accessState && accessState.kind !== "guest") {
    return <WholesaleAccountRequestCard initialState={accessState} />;
  }

  return (
    <section id="mayoreo" className="rounded-lg border border-black/10 bg-white p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-[#fff1f2] text-[#b91c25]">
          <Building2 size={18} />
        </div>
        <div>
          <h2 className="font-semibold">Solicitar cuenta mayorista</h2>
          <p className="mt-1 text-sm text-black/60">
            Envía tus datos para que el equipo revise y apruebe tu acceso. Registrarte como cliente regular no activa precios mayoristas.
          </p>
          <div className="mt-3 rounded-md border border-[#e4252c]/20 bg-[#fff1f2] p-3 text-sm text-[#7f1d1d]">
            <p className="font-semibold">¿Ya tienes cuenta?</p>
            <p className="mt-1">Inicia sesión para solicitar mayoreo con un solo clic.</p>
            <Link href="/login?next=/contacto%23mayoreo" className="mt-2 inline-flex items-center gap-2 font-semibold text-[#b91c25]">
              <LogIn size={15} />
              Iniciar sesión
            </Link>
          </div>
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

        {message ? <p className="rounded-md bg-[#f4f4f5] px-3 py-2 text-sm text-black/65 sm:col-span-2">{message}</p> : null}

        <div className="sm:col-span-2">
          <Button type="submit" variant="dark" disabled={isPending} className="w-full sm:w-auto">
            {isPending ? <Loader2 className="animate-spin" size={17} /> : <Send size={17} />}
            {isPending ? "Enviando solicitud..." : "Solicitar cuenta mayorista"}
          </Button>
        </div>
      </form>

      {successOpen ? (
        <div className="cz-layer-modal fixed inset-0 grid place-items-center bg-black/45 px-4">
          <section className="w-full max-w-md rounded-lg bg-white p-5 text-[#080808] shadow-xl">
            <div className="flex items-start gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-md bg-[#fff1f2] text-[#b91c25]">
                <CheckCircle2 size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold">Solicitud mayorista enviada</h2>
                <p className="mt-2 text-sm leading-6 text-black/65">
                  Recibimos tu solicitud. Nuestro equipo revisara tu cuenta y te notificaremos cuando tengas acceso a precios mayoristas.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSuccessOpen(false)}
                className="grid size-8 shrink-0 place-items-center rounded-md text-black/45 hover:bg-black/5"
                aria-label="Cerrar aviso"
              >
                <X size={16} />
              </button>
            </div>
            <div className="mt-5 flex justify-end">
              <Button type="button" variant="dark" onClick={() => setSuccessOpen(false)}>
                Entendido
              </Button>
            </div>
          </section>
        </div>
      ) : null}
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


