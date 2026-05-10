"use client";

import { useState } from "react";
import { validateHondurasPhone } from "@/utils/validation";

export function ContactForm() {
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");

  function submitContact(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const phoneResult = validateHondurasPhone(phone);
    if (!phoneResult.ok) {
      setMessage(phoneResult.message);
      return;
    }

    setMessage("Solicitud lista para enviar. Nuestro equipo te contactara por WhatsApp.");
  }

  return (
    <form onSubmit={submitContact} className="rounded-lg border border-black/10 bg-white p-5">
      <div className="grid gap-3">
        <input placeholder="Nombre" className="rounded-md border border-black/10 px-3 py-2 text-sm outline-none" />
        <input placeholder="Correo" className="rounded-md border border-black/10 px-3 py-2 text-sm outline-none" />
        <label className="grid gap-1">
          <span className="text-xs font-medium uppercase text-black/50">Teléfono / WhatsApp</span>
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="Ej. 31986284"
            className="rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
          />
        </label>
        <textarea placeholder="Mensaje" className="min-h-32 rounded-md border border-black/10 px-3 py-2 text-sm outline-none" />
        {message ? (
          <p
            className={`rounded-md p-3 text-sm ${
              message.startsWith("Ingresa") ? "bg-[#fff0ea] text-[#9b341b]" : "bg-[#e8f3f2] text-[#1e5960]"
            }`}
          >
            {message}
          </p>
        ) : null}
        <button className="rounded-md bg-[#1c1d1b] px-4 py-3 text-sm font-semibold text-white">Enviar</button>
      </div>
    </form>
  );
}
