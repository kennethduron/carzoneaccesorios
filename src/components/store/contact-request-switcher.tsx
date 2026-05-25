"use client";

import { useEffect, useState } from "react";
import { Building2, MailQuestion, type LucideIcon } from "lucide-react";
import { ContactForm } from "@/components/store/contact-form";
import { WholesaleRequestForm } from "@/components/store/wholesale-request-form";
import type { WholesaleAccessState } from "@/types/wholesale";

type ContactMode = "general" | "mayoreo";

const options: Array<{
  mode: ContactMode;
  title: string;
  description: string;
  Icon: LucideIcon;
}> = [
  {
    mode: "general",
    title: "Contacto general",
    description: "Escríbenos si necesitas información, ayuda con un pedido o tienes una consulta.",
    Icon: MailQuestion,
  },
  {
    mode: "mayoreo",
    title: "Solicitar cuenta mayorista",
    description: "Aplica para acceder a precios mayoristas. Nuestro equipo revisará tu solicitud.",
    Icon: Building2,
  },
];

export function ContactRequestSwitcher({ initialWholesaleState }: { initialWholesaleState: WholesaleAccessState }) {
  const [mode, setMode] = useState<ContactMode>("general");

  useEffect(() => {
    function syncFromUrl() {
      const params = new URLSearchParams(window.location.search);
      const tipo = params.get("tipo")?.toLowerCase();
      const hash = window.location.hash.toLowerCase();

      if (tipo === "mayoreo" || tipo === "mayorista" || hash === "#mayoreo") {
        setMode("mayoreo");
      }
    }

    syncFromUrl();
    window.addEventListener("hashchange", syncFromUrl);
    return () => window.removeEventListener("hashchange", syncFromUrl);
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm font-medium text-black/65">Selecciona el tipo de solicitud que deseas enviar.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {options.map(({ mode: optionMode, title, description, Icon }) => {
            const active = mode === optionMode;
            return (
              <button
                key={optionMode}
                type="button"
                onClick={() => setMode(optionMode)}
                className={`rounded-lg border p-4 text-left transition-colors ${
                  active ? "border-[#e4252c] bg-[#fff1f2]" : "border-black/10 bg-white hover:border-[#e4252c]/50"
                }`}
                aria-pressed={active}
              >
                <span className="flex items-start gap-3">
                  <span className={`grid size-10 shrink-0 place-items-center rounded-md ${active ? "bg-white text-[#b91c25]" : "bg-[#f4f4f5] text-black/60"}`}>
                    <Icon size={18} />
                  </span>
                  <span>
                    <span className="block font-semibold text-[#080808]">{title}</span>
                    <span className="mt-1 block text-sm leading-6 text-black/60">{description}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {mode === "general" ? <ContactForm /> : <WholesaleRequestForm initialAccessState={initialWholesaleState} />}
    </div>
  );
}

