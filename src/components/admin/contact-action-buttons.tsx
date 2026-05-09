"use client";

import { PhoneCall } from "lucide-react";
import { hondurasPhone } from "@/utils/validation";

type ContactActionButtonsProps = {
  phone: string | null | undefined;
  className?: string;
};

export function ContactActionButtons({ phone, className = "" }: ContactActionButtonsProps) {
  const result = phone ? hondurasPhone(phone) : null;

  if (!result?.ok) {
    return <p className={`text-xs font-medium text-[#9b341b] ${className}`}>Teléfono no disponible o inválido.</p>;
  }

  const whatsappPhone = result.value.replace("+", "");
  const whatsappMessage = encodeURIComponent(
    "Hola, le saludamos de Car Zone Accesorios. Queremos darle seguimiento a su solicitud.",
  );

  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      <a
        href={`https://wa.me/${whatsappPhone}?text=${whatsappMessage}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 rounded-md border border-[#16803a]/20 bg-[#16803a] px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#126a31]"
      >
        <WhatsAppIcon />
        WhatsApp
      </a>
      <a
        href={`tel:${result.value}`}
        className="inline-flex items-center gap-1 rounded-md border border-black/10 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1c1d1b] shadow-sm transition-colors hover:bg-[#f7f7f2]"
      >
        <PhoneCall size={13} />
        Llamar
      </a>
    </div>
  );
}

function WhatsAppIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5" fill="currentColor">
      <path d="M12.04 2A9.93 9.93 0 0 0 2.1 11.93c0 1.75.46 3.46 1.32 4.96L2 22l5.24-1.37a9.94 9.94 0 0 0 4.8 1.22h.01A9.93 9.93 0 0 0 12.04 2Zm5.85 14.18c-.25.7-1.45 1.34-2.02 1.39-.52.05-1.17.07-1.89-.12-.44-.12-1-.32-1.72-.63-3.03-1.31-5.01-4.36-5.16-4.56-.15-.2-1.23-1.64-1.23-3.13s.78-2.22 1.06-2.52c.28-.31.61-.39.81-.39h.58c.18.01.43-.07.67.51.25.6.85 2.08.92 2.23.08.15.13.33.03.53-.1.2-.15.33-.3.51-.15.18-.32.4-.46.54-.15.15-.31.32-.13.62.18.31.79 1.3 1.69 2.1 1.16 1.04 2.14 1.36 2.45 1.51.31.15.49.13.67-.08.18-.2.77-.9.98-1.2.2-.31.41-.26.69-.15.28.1 1.8.85 2.1 1 .31.15.51.23.59.36.08.13.08.75-.17 1.45Z" />
    </svg>
  );
}
