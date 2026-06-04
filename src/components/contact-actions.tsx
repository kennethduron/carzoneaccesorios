"use client";

import { Phone } from "lucide-react";
import { FaWhatsapp } from "react-icons/fa";
import { validateHondurasPhone } from "@/utils/validation";

type ContactActionsProps = {
  phone: string | null | undefined;
  customerName: string | null | undefined;
  className?: string;
  whatsappMessage?: string;
};

const defaultWhatsappMessage = "Hola, le saludamos de Car Zone Accesorios. Queremos darle seguimiento a su solicitud.";

export function ContactActions({ phone, customerName, className = "", whatsappMessage: customWhatsappMessage }: ContactActionsProps) {
  const phoneResult = phone ? validateHondurasPhone(phone) : null;
  const contactLabel = customerName?.trim() || "cliente";

  if (!phoneResult?.ok) {
    return <p className={`text-xs font-medium text-[#9b341b] ${className}`}>Teléfono no disponible o inválido.</p>;
  }

  const normalizedPhone = phoneResult.value;
  const whatsappPhone = normalizedPhone.replace(/\D/g, "");
  const encodedWhatsappMessage = encodeURIComponent(customWhatsappMessage?.trim() || defaultWhatsappMessage);

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      <a
        href={`https://wa.me/${whatsappPhone}?text=${encodedWhatsappMessage}`}
        target="_blank"
        rel="noreferrer"
        aria-label={`Contactar por WhatsApp a ${contactLabel}`}
        className="inline-flex items-center gap-1 rounded-md border border-[#16803a]/20 bg-[#16803a] px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#126a31]"
      >
        <FaWhatsapp aria-hidden="true" className="size-3.5" />
        WhatsApp
      </a>
      <a
        href={`tel:${normalizedPhone}`}
        aria-label={`Llamar a ${contactLabel}`}
        className="inline-flex items-center gap-1 rounded-md border border-black/10 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#080808] shadow-sm transition-colors hover:bg-[#f4f4f5]"
      >
        <Phone aria-hidden="true" size={13} />
        Llamar
      </a>
    </div>
  );
}



