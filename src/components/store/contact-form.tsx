"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Loader2, Send } from "lucide-react";
import { submitGeneralContactAction } from "@/app/contacto/actions";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";

const initialForm = {
  name: "",
  email: "",
  phone: "",
  message: "",
};

export function ContactForm() {
  const [form, setForm] = useState(initialForm);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  function updateField(field: keyof typeof initialForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function submitContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");

    startTransition(async () => {
      const result = await submitGeneralContactAction(form);
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
    <form onSubmit={submitContact} className="rounded-lg border border-black/10 bg-white p-5">
      <div className="mb-4">
        <h2 className="font-semibold">Contacto general</h2>
        <p className="mt-1 text-sm text-black/60">Escríbenos si necesitas información, ayuda con un pedido o tienes una consulta.</p>
      </div>
      <div className="grid gap-3">
        <input
          value={form.name}
          onChange={(event) => updateField("name", event.target.value)}
          placeholder="Nombre"
          className="rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
          required
        />
        <input
          type="email"
          value={form.email}
          onChange={(event) => updateField("email", event.target.value)}
          placeholder="Correo electrónico"
          className="rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
          required
        />
        <label className="grid gap-1">
          <span className="text-xs font-medium uppercase text-black/50">Teléfono / WhatsApp</span>
          <input
            value={form.phone}
            onChange={(event) => updateField("phone", event.target.value)}
            placeholder="Ej. 31986284"
            className="rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
            required
          />
        </label>
        <textarea
          value={form.message}
          onChange={(event) => updateField("message", event.target.value)}
          placeholder="Mensaje"
          className="min-h-32 rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
          required
        />
        {message ? (
          <p
            className={`rounded-md p-3 text-sm ${
              message.startsWith("Completa") || message.startsWith("No pudimos")
                ? "bg-[#fff0ea] text-[#9b341b]"
                : "bg-[#fff1f2] text-[#b91c25]"
            }`}
          >
            {message}
          </p>
        ) : null}
        <Button type="submit" variant="dark" disabled={isPending} className="w-full sm:w-auto">
          {isPending ? <Loader2 className="animate-spin" size={17} /> : <Send size={17} />}
          {isPending ? "Enviando mensaje..." : "Enviar mensaje"}
        </Button>
      </div>
    </form>
  );
}

