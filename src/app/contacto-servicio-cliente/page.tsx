import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Clock, Mail, MapPin, Phone } from "lucide-react";
import { FaWhatsapp } from "react-icons/fa";
import { PublicStoreShell } from "@/components/store/public-store-shell";
import { SocialLinks, hasSocialLinks } from "@/components/store/social-links";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";
import { createPublicMetadata } from "@/lib/seo";
import { getPreferredWhatsAppUrl } from "@/utils/contact-settings";

export const dynamic = "force-dynamic";
export const metadata: Metadata = createPublicMetadata({
  title: "Servicio al cliente | Car Zone Accesorios",
  description: "Canales oficiales de atención de Car Zone Accesorios para soporte de pedidos, entregas y productos.",
  path: "/contacto-servicio-cliente",
  absoluteTitle: true,
});

export default async function ContactoServicioClientePage() {
  const settings = await getPublicCompanySettings();
  const whatsapp = getPreferredWhatsAppUrl(settings);

  return (
    <PublicStoreShell>
      <section className="mx-auto max-w-5xl px-5 py-10">
        <p className="text-sm text-black/50">Servicio al cliente</p>
        <h1 className="mt-2 text-4xl font-semibold">Canales oficiales de atención</h1>
        <p className="mt-4 max-w-3xl text-black/60">
          Para soporte de pedidos, pagos, entregas, devoluciones o facturación, usa los canales publicados por el comercio.
        </p>

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {settings.customer_service_phone ? (
            <ContactCard icon={<Phone size={19} />} title="Teléfono" value={settings.customer_service_phone} />
          ) : null}
          {settings.customer_service_email ? (
            <ContactCard icon={<Mail size={19} />} title="Correo electrónico" value={settings.customer_service_email} />
          ) : null}
          {settings.business_address ? (
            <ContactCard icon={<MapPin size={19} />} title="Dirección" value={settings.business_address} />
          ) : null}
          {settings.customer_service_hours ? (
            <ContactCard icon={<Clock size={19} />} title="Horario de atención" value={settings.customer_service_hours} />
          ) : null}
        </div>

        {whatsapp ? (
          <a
            href={whatsapp}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-flex items-center gap-2 rounded-md bg-[#25d366] px-4 py-3 text-sm font-semibold text-white transition-transform hover:scale-[1.01]"
          >
            <FaWhatsapp aria-hidden="true" className="size-[18px]" />
            Contactar por WhatsApp
          </a>
        ) : null}

        {hasSocialLinks(settings) ? (
          <section className="mt-8 rounded-lg border border-black/10 bg-white p-5 shadow-sm">
            <h2 className="font-semibold">También puedes encontrarnos en redes sociales</h2>
            <div className="mt-4">
              <SocialLinks settings={settings} variant="contact" />
            </div>
          </section>
        ) : null}
      </section>
    </PublicStoreShell>
  );
}

function ContactCard({ icon, title, value }: { icon: ReactNode; title: string; value: string }) {
  return (
    <article className="rounded-lg border border-black/10 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-md bg-[#fff1f2] text-[#e4252c]">{icon}</span>
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-black/60">{value}</p>
        </div>
      </div>
    </article>
  );
}
